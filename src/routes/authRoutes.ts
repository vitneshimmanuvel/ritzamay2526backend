import { Router, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import prisma from '../lib/db';
import { authenticateJWT, AuthenticatedRequest } from '../middlewares/authMiddleware';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'supersecretjwtkey_pleasechange';

// Check availability of email or phoneNumber
router.post('/check-availability', async (req: any, res: Response) => {
  try {
    const { email, phoneNumber } = req.body;
    let emailTaken = false;
    let phoneTaken = false;

    if (email) {
      const user = await prisma.user.findUnique({ where: { email } });
      if (user) {
        emailTaken = true;
      }
    }

    if (phoneNumber) {
      const user = await prisma.user.findFirst({ where: { phoneNumber } });
      if (user) {
        phoneTaken = true;
      }
    }

    res.json({ emailTaken, phoneTaken });
  } catch (error) {
    console.error('Check availability error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Register User
router.post('/register', async (req: any, res: Response) => {
  try {
    const { name, email, password, role, department, phoneNumber } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required' });
    }

    // Check existing email
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(400).json({ error: 'User with this email already exists' });
    }

    // Check existing phone number
    if (phoneNumber) {
      const existingPhone = await prisma.user.findFirst({ where: { phoneNumber } });
      if (existingPhone) {
        return res.status(400).json({ error: 'User with this phone number already exists' });
      }
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: {
        name,
        email,
        password: hashedPassword,
        role: role || 'user',
        department: department || null,
        phoneNumber: phoneNumber || null,
      },
    });

    // Generate JWT
    const token = jwt.sign(
      { id: user.id, name: user.name, email: user.email, role: user.role, department: user.department, phoneNumber: user.phoneNumber },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(201).json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        department: user.department,
        phoneNumber: user.phoneNumber,
      },
    });
  } catch (error: any) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Internal server error during registration' });
  }
});

// Login User
router.post('/login', async (req: any, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Generate JWT
    const token = jwt.sign(
      { id: user.id, name: user.name, email: user.email, role: user.role, department: user.department, phoneNumber: user.phoneNumber },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        department: user.department,
        phoneNumber: user.phoneNumber,
      },
    });
  } catch (error: any) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error during login' });
  }
});

// Get current user profile
router.get('/me', authenticateJWT, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        department: true,
        phoneNumber: true,
        createdAt: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user });
  } catch (error: any) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
