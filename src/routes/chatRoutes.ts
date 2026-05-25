import { Router, Response } from 'express';
import { generateOptions, generateAnswer } from '../services/aiService';
import prisma from '../lib/db';
import { authenticateJWT, AuthenticatedRequest } from '../middlewares/authMiddleware';

const router = Router();

// GET all sessions for the authenticated user
router.get('/sessions', authenticateJWT, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

    const sessions = await prisma.chatSession.findMany({
      where: { userId: req.user.id },
      orderBy: { startedAt: 'desc' },
    });
    res.json({ sessions });
  } catch (error: any) {
    console.error('Fetch sessions error:', error);
    res.status(500).json({ error: 'Failed to fetch chat sessions' });
  }
});

// GET messages for a specific session
router.get('/session/:id', authenticateJWT, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const sessionId = String(req.params.id);

    const session = await prisma.chatSession.findFirst({
      where: { id: sessionId, userId: req.user.id },
    });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const messages = await prisma.chatMessage.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' },
    });

    res.json({ messages });
  } catch (error: any) {
    console.error('Fetch session messages error:', error);
    res.status(500).json({ error: 'Failed to fetch session messages' });
  }
});

// POST to generate options
router.post('/options', async (req: any, res: Response) => {
  try {
    const { query, sessionId } = req.body;
    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }

    // Check JWT authentication manually if token is passed (so we can support public and private chat)
    let user: any = null;
    const authHeader = req.headers.authorization;
    if (authHeader) {
      const token = authHeader.split(' ')[1];
      const JWT_SECRET = process.env.JWT_SECRET || 'supersecretjwtkey_pleasechange';
      try {
        const jwt = require('jsonwebtoken');
        user = jwt.verify(token, JWT_SECRET);
      } catch (err) {
        // Skip invalid token, treat as public
      }
    }

    let activeSessionId = sessionId;

    if (user) {
      // Authenticated User: Save to database
      if (!activeSessionId) {
        const newSession = await prisma.chatSession.create({
          data: {
            userId: user.id,
            summary: query.substring(0, 50) + '...',
          },
        });
        activeSessionId = newSession.id;
      }

      // Save user message
      await prisma.chatMessage.create({
        data: {
          sessionId: activeSessionId,
          userId: user.id,
          role: 'user',
          content: query,
        },
      });

      // Log query in analytics
      await prisma.searchAnalytics.create({
        data: {
          userId: user.id,
          query,
        },
      });
    } else {
      // Public User: Log query anonymously in analytics
      await prisma.searchAnalytics.create({
        data: {
          query,
        },
      });
    }

    const options = await generateOptions(query);
    res.json({ options, sessionId: activeSessionId });
  } catch (error: any) {
    console.error("Error in /options:", error.message);
    res.status(500).json({ error: 'Failed to generate options' });
  }
});

// POST to generate answer
router.post('/answer', async (req: any, res: Response) => {
  try {
    const { query, selectedOption, sessionId } = req.body;
    if (!query || !selectedOption) {
      return res.status(400).json({ error: 'Query and selectedOption are required' });
    }

    // Check JWT authentication
    let user: any = null;
    const authHeader = req.headers.authorization;
    if (authHeader) {
      const token = authHeader.split(' ')[1];
      const JWT_SECRET = process.env.JWT_SECRET || 'supersecretjwtkey_pleasechange';
      try {
        const jwt = require('jsonwebtoken');
        user = jwt.verify(token, JWT_SECRET);
      } catch (err) {
        // Skip
      }
    }

    const answer = await generateAnswer(query, selectedOption);

    // Check if the answer indicates a final summary/conclusion
    let nextOptions: any[] = [];
    const lowerAnswer = answer.toLowerCase();
    const isFinalSummary = lowerAnswer.includes("final summary") || 
                           lowerAnswer.includes("in conclusion") || 
                           lowerAnswer.includes("to summarize") || 
                           lowerAnswer.includes("summary of") ||
                           lowerAnswer.includes("summarized") ||
                           lowerAnswer.includes("final conclusion");
                            
    if (!isFinalSummary) {
      nextOptions = await generateOptions(selectedOption, true);
    }

    let activeSessionId = sessionId;

    if (user) {
      // Authenticated User: Save to database. If no session exists yet, create one!
      if (!activeSessionId) {
        const newSession = await prisma.chatSession.create({
          data: {
            userId: user.id,
            summary: query.substring(0, 50) + '...',
          },
        });
        activeSessionId = newSession.id;
      }

      // Save user selection
      await prisma.chatMessage.create({
        data: {
          sessionId: activeSessionId,
          userId: user.id,
          role: 'user',
          content: selectedOption,
          optionClicked: selectedOption,
        },
      });

      // Save assistant answer
      await prisma.chatMessage.create({
        data: {
          sessionId: activeSessionId,
          userId: user.id,
          role: 'assistant',
          content: answer,
        },
      });

      // Log analytics
      await prisma.searchAnalytics.create({
        data: {
          userId: user.id,
          query,
          optionClicked: selectedOption,
        },
      });
    } else {
      // Public log analytics
      await prisma.searchAnalytics.create({
        data: {
          query,
          optionClicked: selectedOption,
        },
      });
    }

    res.json({ answer, options: nextOptions, sessionId: activeSessionId });
  } catch (error: any) {
    console.error("Error in /answer:", error.message);
    res.status(500).json({ error: 'Failed to generate answer' });
  }
});

export default router;
