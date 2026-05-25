import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { initVectorStore } from './services/ragService';

dotenv.config();

const app = express();
const httpServer = createServer(app);

// Import Routes
import chatRoutes from './routes/chatRoutes';
import authRoutes from './routes/authRoutes';
import adminRoutes from './routes/adminRoutes';

// Global Middlewares
app.use(cors({ origin: '*' }));
app.use(helmet({
  contentSecurityPolicy: false, // Turn off for easier development integration
}));
app.use(morgan('dev'));
app.use(express.json());

// Mount Routes
app.use('/api/chat', chatRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);

app.get('/', (req, res) => {
  res.json({ message: 'Welcome to Ritza B2C Consulting API! 🌟' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', environment: process.env.VERCEL ? 'vercel' : 'local' });
});

const PORT = process.env.PORT || 5000;

// Export for Vercel serverless environment
export default app;
module.exports = app;

// Only listen if not running in a serverless environment (like Vercel)
if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
  initVectorStore().then(() => {
    httpServer.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  }).catch(err => {
    console.error("Failed to initialize RAG store:", err);
    httpServer.listen(PORT, () => {
      console.log(`Server is running on port ${PORT} (RAG failed to init)`);
    });
  });
} else {
  // In serverless environment, just initialize vector store asynchronously
  initVectorStore().catch(err => console.error("RAG init error:", err));
}
