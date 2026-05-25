import { Router, Response } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import prisma from '../lib/db';
import { authenticateJWT, requireAdmin, AuthenticatedRequest } from '../middlewares/authMiddleware';
import { ingestDocument } from '../services/ragService';

const router = Router();

// Configure Multer for local uploads (use /tmp for writable serverless filesystem on Vercel)
const uploadDir = process.env.VERCEL 
  ? '/tmp/uploads' 
  : path.join(__dirname, '../../uploads');

if (!fs.existsSync(uploadDir)) {
  try {
    fs.mkdirSync(uploadDir, { recursive: true });
  } catch (err) {
    console.error("Warning: Failed to create upload directory:", err);
  }
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  },
});

const upload = multer({ storage });

// Admin: Get all users
router.get('/users', authenticateJWT, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        department: true,
        phoneNumber: true,
        createdAt: true,
        _count: {
          select: {
            messages: true,
            sessions: true,
          }
        }
      },
    });
    res.json({ users });
  } catch (error: any) {
    console.error('Fetch users error:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Admin: Get specific user's chat sessions and messages
router.get('/users/:id/sessions', authenticateJWT, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = String(req.params.id);
    const sessions = await prisma.chatSession.findMany({
      where: { userId },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' }
        }
      },
      orderBy: { startedAt: 'desc' }
    });
    res.json({ sessions });
  } catch (error) {
    console.error('Fetch user sessions error:', error);
    res.status(500).json({ error: 'Failed to fetch user conversations' });
  }
});

// Admin: Get all documents
router.get('/documents', authenticateJWT, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const documents = await prisma.ragDocument.findMany({
      orderBy: { createdAt: 'desc' },
    });
    res.json({ documents });
  } catch (error: any) {
    console.error('Fetch documents error:', error);
    res.status(500).json({ error: 'Failed to fetch documents' });
  }
});

// Admin: Upload a document
router.post(
  '/documents/upload',
  authenticateJWT,
  requireAdmin,
  upload.single('file'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      const { category } = req.body;
      if (!category) {
        // Clean up file if validation fails
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: 'Category is required' });
      }

      const uploaderName = req.user?.name || 'Admin';

      // Start asynchronous ingestion
      const doc = await ingestDocument(
        req.file.originalname,
        category,
        req.file.path,
        uploaderName
      );

      res.status(201).json({
        message: 'Document uploaded and ingestion process started successfully.',
        document: doc,
      });
    } catch (error: any) {
      console.error('Upload document error:', error);
      res.status(500).json({ error: 'Failed to upload and process document' });
    }
  }
);

// Admin: Delete a document
router.delete('/documents/:id', authenticateJWT, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const docId = String(req.params.id);

    const doc = await prisma.ragDocument.findUnique({ where: { id: docId } });
    if (!doc) {
      return res.status(404).json({ error: 'Document not found' });
    }

    // Delete from DB (onDelete Cascade deletes chunks too)
    await prisma.ragDocument.delete({ where: { id: docId } });

    res.json({ message: 'Document deleted successfully' });
  } catch (error: any) {
    console.error('Delete document error:', error);
    res.status(500).json({ error: 'Failed to delete document' });
  }
});

// Admin: Get Analytics Overview
router.get('/analytics', authenticateJWT, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const totalUsers = await prisma.user.count();
    const totalDocs = await prisma.ragDocument.count();
    const totalQueries = await prisma.searchAnalytics.count();
    const readyDocs = await prisma.ragDocument.findMany({
      where: { status: 'ready' }
    });
    const totalChunks = readyDocs.reduce((acc, doc) => acc + doc.chunkCount, 0);

    // Get query logs grouped by category / day for the graph
    // Using simple mock datasets for now to feed the front-end dashboard
    const weeklyUsage = [
      { name: 'Mon', queries: 24, users: 12 },
      { name: 'Tue', queries: 32, users: 15 },
      { name: 'Wed', queries: 45, users: 20 },
      { name: 'Thu', queries: 38, users: 18 },
      { name: 'Fri', queries: 55, users: 25 },
      { name: 'Sat', queries: 12, users: 6 },
      { name: 'Sun', queries: 8, users: 4 },
    ];

    res.json({
      metrics: {
        totalUsers,
        totalDocs,
        totalQueries,
        totalChunks,
        activeSessions: 18, // Simulated active sockets
      },
      weeklyUsage,
    });
  } catch (error: any) {
    console.error('Analytics error:', error);
    res.status(500).json({ error: 'Failed to retrieve analytics' });
  }
});

export default router;
