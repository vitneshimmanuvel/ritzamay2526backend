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
import { searchKnowledgeBase, correctQueryTypos } from './ragService';

// Levenshtein distance helper for typo tolerance
const levenshteinDistance = (a: string, b: string): number => {
  const tmp = [];
  let i, j;
  for (i = 0; i <= a.length; i++) {
    tmp[i] = [i];
  }
  for (j = 0; j <= b.length; j++) {
    tmp[0][j] = j;
  }
  for (i = 1; i <= a.length; i++) {
    for (j = 1; j <= b.length; j++) {
      tmp[i][j] = Math.min(
        tmp[i - 1][j] + 1, // deletion
        tmp[i][j - 1] + 1, // insertion
        tmp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1) // substitution
      );
    }
  }
  return tmp[a.length][b.length];
};

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

const isTravelRelated = (query: string): boolean => {
  const cleanQuery = query.toLowerCase().trim();
  const correctedQuery = correctQueryTypos(cleanQuery);
  const travelKeywords = [
    // Core verbs/nouns and common typos
    'study', 'stduy', 'studing', 'studdy', 'studt', 'stundy', 'learn', 'education',
    'work', 'wrk', 'working', 'job', 'permit', 'sponsor', 'employ', 'career', 'salary',
    'visa', 'visas', 'pr', 'permanent residenc', 'express entry', 'crs', 'immigration', 'immigrate', 'counsel', 'consult',
    'travel', 'visit', 'tourist', 'tourism', 'schengen', 'passport', 'ticket', 'itinerary',
    'abroad', 'abrad', 'abrod', 'abard', 'overseas', 'foreign', 'destination', 'flight', 'eligibility',
    
    // Academic fields and majors and typos
    'science', 'scece', 'computer', 'engineering', 'tech', 'coding', 'business', 'mba', 'finance', 'arts',
    
    // Levels/Degrees
    'college', 'colg', 'university', 'univ', 'dli', 'loa', 'tuition', 'fee', 'fees',
    'pg', 'ug', 'master', 'bachelor', 'degree', 'course', 'fresher',
    
    // Target countries and common typos
    'canada', 'usa', 'america', 'uk', 'london', 'australia', 'sydney', 'melbourne', 'europe', 'germany', 'france',
    'country', 'countries', 'contry', 'contries',
    
    // Profile indicators
    'ielts', 'toefl', 'gre', 'gmat', 'assessment', 'profile', 'consultant', 'advisor', 'counselor'
  ];
  
  // 1. Direct match on either original or corrected query
  if (travelKeywords.some(keyword => cleanQuery.includes(keyword) || correctedQuery.includes(keyword))) {
    return true;
  }

  // 2. Fuzzy match on individual words from cleanQuery and correctedQuery
  const cleanWords = cleanQuery.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length >= 3);
  const correctedWords = correctedQuery.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length >= 3);
  const allWords = Array.from(new Set([...cleanWords, ...correctedWords]));

  for (const word of allWords) {
    for (const keyword of travelKeywords) {
      if (word.includes(keyword) || keyword.includes(word)) {
        return true;
      }
      
      const dist = levenshteinDistance(word, keyword);
      const maxAllowedDist = keyword.length <= 5 ? 1 : 2;
      if (dist <= maxAllowedDist) {
        console.log(`[Typo-Tolerance] Fuzzy matched query word "${word}" to travel keyword "${keyword}" (distance: ${dist})`);
        return true;
      }
    }
  }

  return false;
};

const isGreeting = (query: string): boolean => {
  const cleanQuery = query.toLowerCase().trim();
  const initialTriggers = ["hi", "hello", "hey", "start", "start chat", "options", "good morning", "good afternoon", "good evening"];
  return initialTriggers.some(t => cleanQuery === t || cleanQuery.startsWith("hi ") || cleanQuery.startsWith("hello "));
};

export const generateChitChatAnswer = async (query: string): Promise<string> => {
  const cleanQuery = query.toLowerCase().trim();
  
  // Specific handler for profile / who are you questions
  if (cleanQuery.includes("who are you") || cleanQuery.includes("your name") || cleanQuery.includes("what is your name")) {
    return "I am Ritza, your friendly advisor and counselor for studying abroad! Or do you want a personal guide for your future? I'm right here to guide you step-by-step! 🌟";
  }

  // Specific handler for greetings
  const greetingTriggers = ["hi", "hello", "hey", "good morning", "good afternoon", "good evening"];
  if (greetingTriggers.some(t => cleanQuery === t || cleanQuery.startsWith("hi ") || cleanQuery.startsWith("hello "))) {
    return "Hey buddy! I'm Ritza, your friendly study abroad advisor and counselor for your future! 🌟 Ask me any question about target countries, colleges, work permits, or visas, and let's get you set up for success! What are you dreaming of exploring today? 😊";
  }

  const prompt = `You are Ritza, an extremely warm, friendly, and helpful B2C study-abroad counselor and personal companion. You speak in a very warm, supportive, buddy-like tone. Use emojis!
  
  CRITICAL PERSONA CONSTRAINT: You must ONLY introduce yourself or say your name ('Ritza') if the user explicitly asks who you are or what your name is. In all other messages, DO NOT say 'I'm Ritza' or introduce yourself at all. Speak naturally and go straight to answering their query like in a real, continuous person-to-person conversation!
  
  CRITICAL COUNSELING BOUNDARY RULE: If the user asks you factual, direct, or academic questions about a specific scientific, technical, academic, or general subject (such as space science, astrophysics, coding, physics, history, cooking, etc.), you must NOT explain or answer that scientific/academic subject directly. Instead, warmly and politely state that unfortunately you don't know that specific subject itself, but you can absolutely help them explore where to study/learn that subject abroad, evaluate top international universities, or plan their future career/study visa options in that field!
  Example response style: "Unfortunately, I don't know much about Space Science itself, but I'd be absolutely thrilled to help you explore where to study Space Science abroad, find top universities, or plan your future career in that exciting field! 🚀🌌"
  
  Reply to the user's random query or chit-chat in a very friendly, natural, and helpful way. Keep your response short (1 to 3 sentences maximum) and end with a nice friendly invitation to talk about their future travel or study abroad plans.
  
  User query: "${query}"`;
  
  return await generateResponse(prompt);
};

export const generateInitialAnswer = async (query: string): Promise<string> => {
  const cleanQuery = query.toLowerCase().trim();

  // Specific handler for profile / who are you questions
  if (cleanQuery.includes("who are you") || cleanQuery.includes("your name") || cleanQuery.includes("what is your name")) {
    return "I am Ritza, your friendly advisor and counselor for studying abroad! Or do you want a personal guide for your future? I'm right here to guide you step-by-step! 🌟";
  }

  // Specific handler for greetings
  const greetingTriggers = ["hi", "hello", "hey", "good morning", "good afternoon", "good evening"];
  if (greetingTriggers.some(t => cleanQuery === t || cleanQuery.startsWith("hi ") || cleanQuery.startsWith("hello "))) {
    return "Hey buddy! I'm Ritza, your friendly study abroad advisor and counselor for your future! 🌟 Ask me any question about target countries, colleges, work permits, or visas, and let's get you set up for success! What are you dreaming of exploring today? 😊";
  }

  const prompt = `You are Ritza, an extremely warm, supportive, B2C study-abroad counselor buddy. You speak in a very brief, conversational, approachable tone. Use emojis!
  
  CRITICAL PERSONA CONSTRAINT: You must NEVER introduce yourself or say your name ('Ritza') in this reply.

  STRICT B2C STUDY ABROAD FOCUS: You are strictly a study-abroad, international college admission, and academic career visa counselor. You are NOT a tourism agent, holiday planner, or family vacation organizer. Even if the query mentions 'family', 'traveling', or 'visiting', you must NEVER suggest holiday vacation plans, family trips, or leisure tourism. Keep your response completely focused on study abroad and career plans. Ground your thoughts directly on the RAG context if applicable.

  EMPATHETIC FRESHER VALIDATION: If the user expresses confusion, struggle, or is unsure about whether to study further vs going to work (e.g. "I don't know what to do", "studying pg or working", "freshers"), you must start your response with a very warm, comforting, and empathetic validation:
  "I completely understand your confusion and frustration as a fresher. This stage comes to so many people in their early career stages. Don't worry at all, let's figure this out step-by-step! 😊"

  Briefly acknowledge their query: "${query}" in 1-2 friendly sentences, reassure them that they have amazing opportunities, and invite them to explore the option cards below! Keep the entire response short (maximum 2 to 3 sentences total).`;

  return await generateResponse(prompt);
};

export const findSimilarPastAnswer = async (query: string): Promise<string | null> => {
  try {
    const cleanQuery = query.toLowerCase().trim();
    // Avoid matching simple greetings
    if (isGreeting(query) || query.length < 5) return null;

    const pastUserMessages = await prisma.chatMessage.findMany({
      where: { role: 'user' },
      orderBy: { createdAt: 'desc' },
      take: 100 // check last 100 queries
    });

    let bestMatch: any = null;
    let highestSimilarity = 0;

    for (const msg of pastUserMessages) {
      // Skip if the text matches exactly the query (to avoid self-matching)
      if (msg.content.toLowerCase().trim() === cleanQuery) continue;

      const sim = calculateSimilarity(query, msg.content);
      if (sim > highestSimilarity) {
        highestSimilarity = sim;
        bestMatch = msg;
      }
    }

    if (highestSimilarity > 0.65 && bestMatch) {
      console.log(`[RAG-Similarity] Found highly similar past user question: "${bestMatch.content}" (Similarity: ${(highestSimilarity * 100).toFixed(1)}%)`);
      // Get the subsequent assistant message in the same session
      const assistantMsg = await prisma.chatMessage.findFirst({
        where: {
          sessionId: bestMatch.sessionId,
          createdAt: { gt: bestMatch.createdAt },
          role: 'assistant'
        },
        orderBy: { createdAt: 'asc' }
      });

      if (assistantMsg && assistantMsg.content) {
        // Prepend the friendly yes/no confirmation header
        return `Hey buddy, are you looking for this output? If yes, perfect! If no, okay let's go with the flow! 😊\n\n${assistantMsg.content}`;
      }
    }
  } catch (err) {
    console.error("Failed to lookup similar past answer:", err);
  }
  return null;
};

export const generateOptions = async (query: string, isFollowUp: boolean = false) => {
  const cleanQuery = query.toLowerCase().trim();

  // If this is a user-typed query (not a direct option click follow-up)
  // and is NOT travel/immigration related, bypass option cards entirely!
  // This prevents cards from popping up for greetings or off-topic chit-chat.
  if (!isFollowUp && !isTravelRelated(query)) {
    console.log(`[RAG-Persona] Off-topic/greeting query detected: "${query}". Bypassing options/cards.`);
    return [];
  }

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
  
  const prompt = `You are Ritza, a warm, supportive, and friendly B2C study-abroad counselor buddy. You design the B2C consulting conversation to be entirely card-driven and interactive.

The user is exploring this step: "${query}".
Here is some context from our travel/immigration database:
"${context}"

Your job is to generate exactly 5 clickable option cards that help the user select their next step, resolve their dilemmas, or choose specific information details.

STRICT B2C STUDY ABROAD FOCUS: You are strictly a study-abroad, international college admission, and academic career visa counselor. You are NOT a tourism agent, holiday planner, or family vacation organizer. Even if the user mentions 'family', 'traveling', or 'visiting', you must NEVER suggest holiday vacation plans, family trips, or leisure tourism. Keep the option cards completely focused on study abroad pathways, college budgets, family support for educational tuition, career opportunities, and student eligibility!

CRITICAL COUNSELING PATHWAY RULE: Do NOT just output generic visa subclasses or dry database facts. If the user is struggling to choose between options (such as deciding whether to study further vs. going to work, figuring out target countries, or questioning what to do with their career/future), you MUST generate option cards that present direct, empathetic counseling choices to resolve their struggle!
For example:
- Budget / Family support choices: "Budget: Can my family support study tuition? 💰", "Low Cost: Countries with low/zero tuition 📈"
- Career pathway choices: "Direct Work: Tech job sponsor pathways 💼", "Study & Work: Part-time student jobs & PGWP 🎓"
- Practical dilemmas: "Career: Do you want coding jobs or research? 🎯", "Destination: Best countries for Computer Science graduates 🚀"
- Evaluation: "Evaluation: Chat with Ritza to assess my profile step-by-step 🌟"

Make the option card choices feel highly personal, helpful, and empathetic to a real person-to-person guidance chat! Do NOT discuss B2B employee policies.

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

  const prompt = `You are Ritza, an extremely warm, friendly, and supportive B2C study-abroad counselor buddy. You speak in a very natural, brief, conversational, and approachable "buddy" style. You are helping them as a personal guide for their future.

CRITICAL PERSONA CONSTRAINT: You must NEVER introduce yourself or say your name ('Ritza') in this reply. In all chat responses, speak naturally, go straight to commenting on their choice, and do not repeat 'I'm Ritza' or introduce yourself. Speak like in a real, continuous person-to-person conversation.

STRICT B2C STUDY ABROAD FOCUS: You are strictly a study-abroad, international college admission, and academic career visa counselor. You are NOT a tourism agent, holiday planner, or family vacation organizer. Even if the user mentions 'family', 'traveling', or 'visiting', you must NEVER suggest holiday vacation plans, family trips, or leisure tourism. Keep your advice completely focused on study abroad options, college budgets, family support for educational tuition, and student career pathways! Ground all advice directly in the RAG database context provided below.

EMPATHETIC FRESHER VALIDATION: If the user originally asked a query or expressed confusion/struggle (such as deciding whether to study further vs. going to work, or being unsure of what to do with their career/future), you must start your response with a very warm, comforting, and empathetic validation. Reassure them with phrases like: "I completely understand your confusion/frustration as a fresher. This stage comes to so many people in their early career stages. Don't worry at all, let's figure this out step-by-step! 😊".

CRITICAL CONSTRAINT: You must NEVER output long lists of information, raw tables, or detailed country breakdowns directly in your text response. Keep your reply extremely short (maximum 1 to 2 sentences) and friendly — act purely as a guide. Do not list details like budgets, flight costs, or requirements in this text. Instead, just give a warm 1-sentence consulting acknowledgement of their choice: "${selectedOption}" and briefly ask them to choose the next card!

The user originally asked: "${query}". 
They then specifically selected this follow-up topic: "${selectedOption}".

Here is the context from our database:
"${context}"`;

  return await generateResponse(prompt);
};

// End of Ritza AI Service. Trigger redeploy.
