import fs from 'fs';
import mammoth from 'mammoth';
import { QdrantClient } from '@qdrant/js-client-rest';
import prisma from '../lib/db';

const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const QDRANT_API_KEY = process.env.QDRANT_API_KEY || '';

let qdrantClient: QdrantClient | null = null;

if (QDRANT_URL) {
  try {
    qdrantClient = new QdrantClient({
      url: QDRANT_URL,
      apiKey: QDRANT_API_KEY || undefined,
    });
  } catch (error) {
    console.warn("Failed to initialize Qdrant client:", error);
  }
}

// In-memory dummy data to start with if DB has no documents
const defaultOverseasData = [
  "Overseas Study: Students looking to study abroad in Canada, the US, or the UK must obtain a Study Permit / Student Visa. Canadian Study Permits require a letter of acceptance (LOA) from a Designated Learning Institution (DLI) and proof of funds of at least $20,635 CAD.",
  "Overseas Work: Skilled professionals can apply for international Work Permits. In Australia, the Temporary Skill Shortage (subclass 482) visa allows employers to sponsor skilled workers. The UK Skilled Worker Visa requires a job offer from an approved sponsor and a minimum salary threshold.",
  "Permanent Residency (PR): Canada's Express Entry is a popular system managing applications for three federal economic immigration programs (FSWP, FSTP, CEC) based on a Comprehensive Ranking System (CRS) score (points for age, education, language capability, work experience).",
  "Immigration Counseling: Our expert RITZA consultants provide guidance across 12 layers of travel planning, starting from assessing your profile, suggesting DLIs, visa documentation prep, interview coaching, and pre-departure briefings.",
  "Overseas Visit/Tourism: Tourist Visas (Visitor Visas / eTAs) allow travelers to explore overseas countries for up to 6 months. Schengen Tourist Visas cover 27 European countries and require travel insurance, a detailed itinerary, and proof of accommodation.",
  "Visa Rejections: Common reasons for visa rejections include lack of travel history, insufficient financial proof, weak ties to home country, or unclear purpose of visit. RITZA helps review rejections and build stronger re-application packages."
];

// Helper to check if Qdrant is responsive
async function isQdrantHealthy(): Promise<boolean> {
  if (!qdrantClient) return false;
  try {
    await qdrantClient.getCollections();
    return true;
  } catch {
    return false;
  }
}

// Initialize Qdrant Collection if healthy
export const initVectorStore = async () => {
  const collectionName = "enterprise_knowledge";
  if (await isQdrantHealthy() && qdrantClient) {
    try {
      const collections = await qdrantClient.getCollections();
      const exists = collections.collections.some(c => c.name === collectionName);
      if (!exists) {
        await qdrantClient.createCollection(collectionName, {
          vectors: {
            size: 384, // size for standard all-MiniLM-L6-v2 embeddings
            distance: "Cosine"
          }
        });
        console.log(`Qdrant collection '${collectionName}' created.`);
      } else {
        console.log(`Qdrant collection '${collectionName}' already exists.`);
      }
    } catch (error) {
      console.warn("Qdrant collection initialization failed:", error);
    }
  } else {
    console.log("Qdrant is not reachable. RAG will fall back to native database keyword search.");
  }
};

// Chunk text
export const chunkText = (text: string, chunkSize: number = 800, overlap: number = 150): string[] => {
  const chunks: string[] = [];
  let index = 0;
  
  // Clean whitespace
  const cleanText = text.replace(/\s+/g, ' ').trim();
  
  while (index < cleanText.length) {
    const chunk = cleanText.substring(index, index + chunkSize);
    chunks.push(chunk);
    index += chunkSize - overlap;
  }
  
  return chunks;
};

// Parse file to text
export const parseFileToText = async (filePath: string, originalName: string): Promise<string> => {
  const buffer = fs.readFileSync(filePath);
  const fileExtension = originalName.split('.').pop()?.toLowerCase();

  if (fileExtension === 'pdf') {
    const pdf = require('pdf-parse');
    const data = await pdf(buffer);
    return data.text;
  } else if (fileExtension === 'docx') {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  } else {
    // Default to plain text
    return buffer.toString('utf-8');
  }
};

// Ingest a document
export const ingestDocument = async (
  filename: string,
  category: string,
  filePath: string,
  uploadedBy: string
) => {
  // 1. Create document record
  const doc = await prisma.ragDocument.create({
    data: {
      filename,
      category,
      uploadedBy,
      status: 'processing',
    },
  });

  try {
    // 2. Parse text and chunk
    const rawText = await parseFileToText(filePath, filename);
    const chunks = chunkText(rawText);

    // 3. Save chunks to Database
    await prisma.documentChunk.createMany({
      data: chunks.map(chunk => ({
        documentId: doc.id,
        content: chunk,
      })),
    });

    // 4. Update status and chunk count
    await prisma.ragDocument.update({
      where: { id: doc.id },
      data: {
        chunkCount: chunks.length,
        status: 'ready',
      },
    });

    // 5. Try indexing to Qdrant (in a real app, generate embeddings first)
    if (await isQdrantHealthy() && qdrantClient) {
      try {
        const points = chunks.map((chunk, idx) => {
          // Dummy 384-dim vector for simulation, since embedding model is not local
          // In production, you would call an embedding API (e.g. OpenAI, HuggingFace)
          const dummyVector = Array.from({ length: 384 }, () => Math.random());
          return {
            id: `${doc.id}-${idx}`,
            vector: dummyVector,
            payload: {
              documentId: doc.id,
              filename,
              category,
              content: chunk,
            },
          };
        });

        await qdrantClient.upsert("enterprise_knowledge", {
          wait: true,
          points
        });
      } catch (err) {
        console.error("Failed to index chunks in Qdrant:", err);
      }
    }

    return doc;
  } catch (error) {
    console.error(`Failed to ingest document ${filename}:`, error);
    await prisma.ragDocument.update({
      where: { id: doc.id },
      data: { status: 'failed' },
    });
    throw error;
  }
};

// Search RAG knowledge base
export const searchKnowledgeBase = async (query: string, k: number = 4): Promise<string> => {
  // Try retrieving database chunks first
  const dbChunks = await prisma.documentChunk.findMany({
    include: { document: true }
  });

  // If no chunks are indexed in the database, fall back to default overseas dummy data
  if (dbChunks.length === 0) {
    return defaultOverseasData.slice(0, k).join("\n\n");
  }

  // Basic keyword relevance matching
  const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  
  if (queryWords.length === 0) {
    return dbChunks.slice(0, k).map(c => `[Category: ${c.document.category}] ${c.content}`).join("\n\n");
  }

  const scoredChunks = dbChunks.map(chunk => {
    const contentLower = chunk.content.toLowerCase();
    let score = 0;
    queryWords.forEach(word => {
      if (contentLower.includes(word)) {
        score += 1;
        // Exact word match bonus
        const regex = new RegExp(`\\b${word}\\b`, 'g');
        const matches = contentLower.match(regex);
        if (matches) score += matches.length * 0.5;
      }
    });
    return { chunk, score };
  });

  // Sort by score desc
  scoredChunks.sort((a, b) => b.score - a.score);

  // If no matching words, return the top recent chunks
  if (scoredChunks[0].score === 0) {
    return dbChunks.slice(0, k).map(c => `[Category: ${c.document.category}] ${c.content}`).join("\n\n");
  }

  return scoredChunks
    .slice(0, k)
    .map(r => `[Category: ${r.chunk.document.category}] ${r.chunk.content}`)
    .join("\n\n");
};
