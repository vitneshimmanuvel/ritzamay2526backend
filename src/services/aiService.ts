import { ChatGroq } from "@langchain/groq";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { PromptTemplate } from "@langchain/core/prompts";
import ollama from 'ollama';
import dotenv from 'dotenv';
dotenv.config();

const provider = process.env.AI_PROVIDER || 'ollama';

// Helper to interact with Groq
const callGroq = async (prompt: string): Promise<string> => {
  if (!process.env.GROQ_API_KEY) throw new Error("GROQ_API_KEY is not set.");
  const chatModel = new ChatGroq({
    apiKey: process.env.GROQ_API_KEY,
    model: "llama-3.1-8b-instant",
    temperature: 0.3,
  });
  const res = await chatModel.invoke(prompt);
  return res.content.toString();
};

// Helper to interact with Ollama
const callOllama = async (prompt: string): Promise<string> => {
  const response = await ollama.chat({
    model: process.env.OLLAMA_MODEL || 'llama3',
    messages: [{ role: 'user', content: prompt }],
  });
  return response.message.content;
};

// Main routing function
export const generateResponse = async (prompt: string): Promise<string> => {
  if (provider === 'groq') {
    return await callGroq(prompt);
  }
  return await callOllama(prompt);
};
import prisma from '../lib/db';
import { searchKnowledgeBase } from './ragService';

// Helper to calculate similarity between two strings (Jaccard similarity of words)
const calculateSimilarity = (str1: string, str2: string): number => {
  const clean = (s: string) => s.toLowerCase()
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?]/g, "")
    .split(/\s+/)
    .filter(w => w.length > 2);

  const words1 = new Set(clean(str1));
  const words2 = new Set(clean(str2));

  if (words1.size === 0 || words2.size === 0) return 0;

  let intersection = 0;
  words1.forEach(word => {
    if (words2.has(word)) intersection++;
  });

  const union = new Set([...words1, ...words2]).size;
  return intersection / union;
};

export const generateOptions = async (query: string, isFollowUp: boolean = false) => {
  const cleanQuery = query.toLowerCase().trim();
  const initialTriggers = ["hi", "hello", "hey", "start", "start chat", "options"];
  const isInitial = !isFollowUp && (
    initialTriggers.some(t => cleanQuery === t || cleanQuery.startsWith("hi ")) || 
    query.length < 5 ||
    cleanQuery.includes("abrad studdty") ||
    cleanQuery.includes("can i know about")
  );

  if (isInitial) {
    return [
      { id: "1", emoji: "📚", text: "Study Abroad: Guide me on student visas, colleges, & DLIs" },
      { id: "2", emoji: "💼", text: "Work Abroad: Find international job permits & visa sponsorships" },
      { id: "3", emoji: "🗺️", text: "PR & Immigration: Assess Canada Express Entry & Australia PR eligibility" },
      { id: "4", emoji: "✈️", text: "Visit & Tourism: Apply for travel visas & plan tourism itineraries" },
      { id: "5", emoji: "🎯", text: "Profile Assessment: Chat with Ritza to evaluate my travel eligibility" },
    ];
  }

  // Check if we have saved options for a similar query stage in the database
  try {
    const savedStages = await prisma.savedStageOptions.findMany();
    let bestMatch: any = null;
    let highestSimilarity = 0;

    for (const stage of savedStages) {
      const sim = calculateSimilarity(query, stage.query);
      if (sim > highestSimilarity) {
        highestSimilarity = sim;
        bestMatch = stage;
      }
    }

    // If we have a very close match (Jaccard similarity > 0.65)
    if (highestSimilarity > 0.65 && bestMatch) {
      console.log(`[RAG-Stage] Found similar stage match in database: "${bestMatch.query}" (Similarity: ${(highestSimilarity * 100).toFixed(1)}%). Suggesting saved options.`);
      const optionsArray = bestMatch.options as any[];
      return optionsArray.map((opt, idx) => ({
        id: idx.toString(),
        text: opt.text,
        emoji: opt.emoji
      }));
    }
  } catch (err) {
    console.error("Failed to fetch similar stages from database:", err);
  }

  const context = await searchKnowledgeBase(query);
  
  const prompt = `You are Ritza, a friendly B2C travel & immigration consulting assistant. You design the B2C consulting conversation to be entirely card-driven and interactive.

The user is exploring this step: "${query}".
Here is some context from our travel/immigration database:
"${context}"

Your job is to generate exactly 5 clickable option cards that help the user select their next step, explore countries, or choose specific information details.
Each option card text should be highly specific, engaging, and information-rich, presenting actual choices or pathways for them to click!
For example:
- Specific countries to explore: "Canada: Study Permit & Express Entry 🇨🇦", "USA: Ivy League & F-1 Visas 🇺🇸", "UK: Russel Group & Skilled Work 🇬🇧"
- Budget choices: "Budget: Low Tuition Countries 📉", "Budget: High Return on Investment 💰"
- Processing speed: "Fast Processing Pathways ⚡", "Direct PR Streams 🗺️"
- Assessment details: "Test Requirements: IELTS & TOEFL 📝", "Work Experience Evaluation 💼"

Provide options that let the user drill directly into the details by tapping the cards! Do NOT discuss B2B employee policies.

Assign a highly relevant single emoji to each option card.
Format the output strictly as a JSON array of objects, like this: [{"emoji": "📚", "text": "Option card 1"}, {"emoji": "💼", "text": "Option card 2"}]. Do not output any markdown formatting, just the raw JSON array.`;
  
  let responseText = await generateResponse(prompt);
  
  // Clean up potential markdown blocks if the LLM misbehaves
  responseText = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
  
  try {
    const parsedData: {emoji: string, text: string}[] = JSON.parse(responseText);
    const optionsArray = parsedData.slice(0, 5).map((item, idx) => ({
      id: idx.toString(),
      text: item.text,
      emoji: item.emoji
    }));

    // Save/index this stage and its options in the database for future similarity match
    try {
      await prisma.savedStageOptions.upsert({
        where: { query },
        update: { options: optionsArray },
        create: { query, options: optionsArray }
      });
      console.log(`[RAG-Stage] Indexed new stage options in database for query: "${query}"`);
    } catch (err) {
      console.error("Failed to index generated options in database:", err);
    }

    return optionsArray;
  } catch (error) {
    console.error("Failed to parse options JSON:", responseText);
    return [
      { id: "1", emoji: "📚", text: "Study Abroad: Guide me on student visas, colleges, & DLIs" },
      { id: "2", emoji: "💼", text: "Work Abroad: Find international job permits & visa sponsorships" },
      { id: "3", emoji: "🗺️", text: "PR & Immigration: Assess Canada Express Entry & Australia PR eligibility" },
      { id: "4", emoji: "✈️", text: "Visit & Tourism: Apply for travel visas & plan tourism itineraries" },
      { id: "5", emoji: "🎯", text: "Profile Assessment: Chat with Ritza to evaluate my travel eligibility" },
    ];
  }
};

export const generateAnswer = async (query: string, selectedOption: string) => {
  const context = await searchKnowledgeBase(selectedOption);

  const prompt = `You are Ritza, a warm, friendly, and expert B2C travel & immigration consultant girl. You speak in an extremely brief, conversational, approachable tone. You assist individual B2C clients, not B2B employees.

CRITICAL CONSTRAINT: You must NEVER output long lists of information, raw tables, or detailed country breakdowns directly in your text response. Keep your reply extremely short (maximum 1 to 2 sentences) and friendly — act purely as a guide. Do not list details like budgets, flight costs, or requirements in this text. Instead, just give a warm 1-sentence consulting acknowledgement of their choice: "${selectedOption}" and briefly ask them to choose the next card!

The user originally asked: "${query}". 
They then specifically selected this follow-up topic: "${selectedOption}".

Here is the context from our database:
"${context}"`;

  return await generateResponse(prompt);
};
