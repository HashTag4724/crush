import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { Server as SocketIOServer } from 'socket.io';
import { createServer as createViteServer } from 'vite';
import { connectMongo, inMemoryDb } from './server/db.js';
import { CrashGameEngine } from './server/gameEngine.js';
import {
  calculateTurnoverStatus,
  claimReferralBonus,
  submitUserDeposit,
  submitAgentEntry,
} from './server/p2pEngine.js';
import { askKophbeAI } from './server/gemini.js';
import {
  verifyAdminLogin,
  getLockoutStatus,
  requireAdminAuth,
  logoutAdminToken,
} from './server/adminAuth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Connect to MongoDB if URI is configured
  await connectMongo();

  // Create HTTP Server & Socket.io
  const httpServer = http.createServer(app);
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
  });

  // Start Crash Game Socket Engine
  const gameEngine = new CrashGameEngine(io);

  // --- API Routes ---

  // Health check
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      gameRunning: gameEngine.state,
      multiplier: gameEngine.currentMultiplier,
    });
  });

  // --- User Authentication (Sign Up & Login) ---

  // Sign Up: Requires Player Id, Password, Confirm Password
  app.post('/api/auth/signup', (req, res) => {
    const { playerId, password, confirmPassword } = req.body;

    if (!playerId || !password || !confirmPassword) {
      return res.status(400).json({
        error: 'All fields are required: Player ID, Password, and Confirm Password (সকল তথ্য আবশ্যক)।',
      });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({
        error: 'Passwords do not match! Please make sure Password and Confirm Password match (পাসওয়ার্ড মিলছে না)।',
      });
    }

    if (password.length < 4) {
      return res.status(400).json({
        error: 'Password must be at least 4 characters long (পাসওয়ার্ড কমপক্ষে ৪ অক্ষরের হতে হবে)।',
      });
    }

    const result = inMemoryDb.registerUser(playerId, password);
    if (!result.success || !result.user) {
      return res.status(400).json({ error: result.error || 'Failed to create account.' });
    }

    res.json({
      success: true,
      message: `Account created successfully! Welcome ${result.user.username} to hash tag! 200 Tk sign-up bonus awarded.`,
      user: result.user,
      bonusAmount: 200,
      showFirstLoginBonus: true,
      turnover: calculateTurnoverStatus(result.user),
    });
  });

  // Login: Requires Player Id, Password
  app.post('/api/auth/login', (req, res) => {
    const { playerId, password } = req.body;

    if (!playerId || !password) {
      return res.status(400).json({
        error: 'Player ID and Password are required to log in (প্লেয়ার আইডি ও পাসওয়ার্ড লিখুন)।',
      });
    }

    const result = inMemoryDb.loginUser(playerId, password);
    if (!result.success || !result.user) {
      return res.status(401).json({ error: result.error || 'Invalid credentials.' });
    }

    const isFirstTime = !result.user.firstLoginBonusClaimed;

    res.json({
      success: true,
      message: `Welcome back, ${result.user.username}!`,
      user: result.user,
      bonusAmount: 200,
      showFirstLoginBonus: isFirstTime,
      turnover: calculateTurnoverStatus(result.user),
    });
  });

  // Claim or Acknowledge 200 Tk First Login Firecracker Bonus
  app.post('/api/user/claim-first-bonus', (req, res) => {
    const { userId } = req.body;
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }
    const result = inMemoryDb.claimFirstLoginBonus(userId);
    const turnover = calculateTurnoverStatus(result.user!);

    io.emit('wallet_updated', { userId, user: result.user, turnover });
    res.json({
      success: true,
      message: '200 Tk First Login Bonus claimed successfully!',
      user: result.user,
      bonusAmount: 200,
      turnover,
    });
  });

  // Get User Profile & Wallet Turnover info
  app.get('/api/user/:userId', (req, res) => {
    const { userId } = req.params;
    const user = inMemoryDb.getUser(userId);
    const turnover = calculateTurnoverStatus(user);
    res.json({
      user,
      turnover,
    });
  });

  // Claim 200 BDT Referral Bonus (Qualified by 500 Tk friend deposit)
  app.post('/api/user/claim-referral', (req, res) => {
    const { userId, friendDepositAmount = 500 } = req.body;
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    const result = claimReferralBonus(userId, parseFloat(friendDepositAmount) || 500);
    if (!result.success) {
      return res.status(400).json({ error: result.message });
    }

    const turnover = calculateTurnoverStatus(result.user);

    // Notify user via socket if connected
    io.emit('wallet_updated', { userId, user: result.user, turnover });

    res.json({
      ...result,
      turnover,
    });
  });

  // User P2P Deposit Submission
  app.post('/api/p2p/user-deposit', (req, res) => {
    const { userId, username, trxId, amount, method, senderNumber } = req.body;

    if (!userId || !trxId || !amount || !method) {
      return res.status(400).json({ error: 'Missing required deposit fields (TrxID, amount, method).' });
    }

    const numericAmount = parseFloat(amount);
    if (isNaN(numericAmount) || numericAmount < 10) {
      return res.status(400).json({ error: 'Minimum deposit amount is 10 BDT.' });
    }

    const result = submitUserDeposit(
      userId,
      username || 'Player',
      trxId,
      numericAmount,
      method,
      senderNumber || '01700000000'
    );

    if (result.matched && result.creditedUser) {
      const turnover = calculateTurnoverStatus(result.creditedUser);
      io.emit('wallet_updated', {
        userId,
        user: result.creditedUser,
        turnover,
        notification: `Deposit of ${numericAmount} BDT Approved via Auto-Match!`,
      });
    }

    res.json(result);
  });

  // Agent P2P Received Entry Submission (For testing auto-matching or Agent Terminal)
  app.post('/api/p2p/agent-entry', (req, res) => {
    const { agentId, agentName, trxId, amount, method, receiverNumber } = req.body;

    if (!trxId || !amount || !method) {
      return res.status(400).json({ error: 'Missing required agent fields (TrxID, amount, method).' });
    }

    const numericAmount = parseFloat(amount);
    const result = submitAgentEntry(
      agentId || 'agent_main',
      agentName || 'Official Agent',
      trxId,
      numericAmount,
      method,
      receiverNumber || '01900000000'
    );

    if (result.matched && result.creditedUser) {
      const turnover = calculateTurnoverStatus(result.creditedUser);
      io.emit('wallet_updated', {
        userId: result.creditedUser.userId,
        user: result.creditedUser,
        turnover,
        notification: `Agent matched TrxID ${trxId}! ${numericAmount} BDT Credited!`,
      });
    }

    res.json(result);
  });

  // Get P2P queue & transactions for current user and agent records
  app.get('/api/p2p/status/:userId', (req, res) => {
    const { userId } = req.params;
    const userDeposits = inMemoryDb.userDeposits.filter((d) => d.userId === userId);
    const agentRecords = inMemoryDb.agentDeposits;
    res.json({
      userDeposits,
      agentRecords,
    });
  });

  // Withdrawal Request with Account Password Verification & Turnover Check
  app.post('/api/wallet/withdraw', (req, res) => {
    const { userId, amount, method, targetNumber, password } = req.body;
    if (!userId || !amount) {
      return res.status(400).json({ error: 'User ID and withdrawal amount are required.' });
    }

    // MANDATORY WITHDRAWAL PASSWORD REQUIREMENT: "r withdraw dite geleo same password lagbei"
    if (!password) {
      return res.status(400).json({
        error: 'Account password is required to withdraw funds (টাকা তোলার জন্য একাউন্ট পাসওয়ার্ড আবশ্যক)।',
      });
    }

    const isPasswordValid = inMemoryDb.verifyUserPassword(userId, password);
    if (!isPasswordValid) {
      return res.status(401).json({
        error: 'Incorrect account password! Withdrawal request rejected (ভুল পাসওয়ার্ড! সঠিক পাসওয়ার্ড দিন)।',
      });
    }

    const user = inMemoryDb.getUser(userId);
    const turnover = calculateTurnoverStatus(user);
    const withdrawAmount = parseFloat(amount);

    if (withdrawAmount <= 0 || withdrawAmount > user.balance) {
      return res.status(400).json({ error: 'Invalid withdrawal amount or insufficient balance.' });
    }

    if (!turnover.canWithdraw) {
      return res.status(400).json({
        error: `Turnover requirement not met! You need to bet at least ${turnover.remainingTurnover} BDT more before withdrawing.`,
        turnover,
      });
    }

    // Process withdrawal
    const updatedUser = inMemoryDb.updateUser(userId, {
      balance: user.balance - withdrawAmount,
    });
    inMemoryDb.recordWithdrawal(withdrawAmount);

    res.json({
      success: true,
      message: `Withdrawal request of ${withdrawAmount} BDT submitted to ${method || 'bKash'} (${targetNumber || 'Account'}). Verified with account password!`,
      user: updatedUser,
      turnover: calculateTurnoverStatus(updatedUser),
    });
  });

  // Reset Demo Balance (1,000 BDT)
  app.post('/api/user/reset-demo', (req, res) => {
    const { userId } = req.body;
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required.' });
    }
    const user = inMemoryDb.getUser(userId);
    const updatedUser = inMemoryDb.updateUser(userId, { demoBalance: 1000 });
    res.json({
      success: true,
      message: 'Demo balance reset to 1,000 BDT!',
      user: updatedUser,
    });
  });

  // --- Admin Authentication & Security Endpoints ---
  // Public lockout status check
  app.get('/api/admin/lockout-status', (req, res) => {
    const status = getLockoutStatus(req);
    res.json(status);
  });

  // Admin login endpoint (Verifies password server-side; enforces 5 failed attempts lockout)
  app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    if (!password) {
      return res.status(400).json({ error: 'Password is required.' });
    }

    const result = verifyAdminLogin(req, password);
    if (!result.success) {
      const statusCode = result.isLocked ? 429 : 401;
      return res.status(statusCode).json(result);
    }

    res.json(result);
  });

  // Admin logout endpoint
  app.post('/api/admin/logout', (req, res) => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      logoutAdminToken(token);
    }
    res.json({ success: true, message: 'Logged out successfully.' });
  });

  // --- Admin Panel Endpoints (Protected by requireAdminAuth) ---
  app.get('/api/admin/stats', requireAdminAuth, (req, res) => {
    const pendingDeposits = inMemoryDb.userDeposits.filter((d) => d.status === 'PENDING');
    const allUsers = Array.from(inMemoryDb.users.values());
    const hourly = inMemoryDb.getHourlyStats();
    res.json({
      stats: inMemoryDb.platformStats,
      ownerBalance: inMemoryDb.platformStats.adminBalance,
      adminBalance: inMemoryDb.platformStats.adminBalance,
      hourly,
      pendingDeposits,
      totalUsers: allUsers.length,
      users: allUsers,
      gameRunning: gameEngine.state,
      currentMultiplier: gameEngine.currentMultiplier,
      activeBetsCount: gameEngine.currentBets.size,
      cycle: gameEngine.getCycleStatus(),
    });
  });

  app.post('/api/admin/adjust-vault', requireAdminAuth, (req, res) => {
    const { amount, action } = req.body; // action: 'deposit' | 'withdraw'
    const num = parseFloat(amount);
    if (!num || num <= 0) {
      return res.status(400).json({ error: 'Invalid amount.' });
    }

    if (action === 'withdraw') {
      if (inMemoryDb.platformStats.adminBalance < num) {
        return res.status(400).json({ error: 'Insufficient admin vault balance.' });
      }
      inMemoryDb.platformStats.adminBalance -= num;
      inMemoryDb.platformStats.ownerBalance = inMemoryDb.platformStats.adminBalance;
    } else {
      inMemoryDb.platformStats.adminBalance += num;
      inMemoryDb.platformStats.ownerBalance = inMemoryDb.platformStats.adminBalance;
    }

    res.json({
      success: true,
      ownerBalance: inMemoryDb.platformStats.adminBalance,
      adminBalance: inMemoryDb.platformStats.adminBalance,
      stats: inMemoryDb.platformStats,
      message: `Admin vault ${action === 'withdraw' ? 'withdrew' : 'deposited'} ${num} BDT successfully!`,
    });
  });

  app.post('/api/admin/set-rtp', requireAdminAuth, (req, res) => {
    const { rtp } = req.body;
    const numRtp = parseFloat(rtp);
    if (!numRtp || numRtp < 0.85 || numRtp > 0.99) {
      return res.status(400).json({ error: 'RTP must be between 0.85 and 0.99 (85% - 99%).' });
    }
    inMemoryDb.platformStats.houseRTP = numRtp;
    res.json({
      success: true,
      houseRTP: inMemoryDb.platformStats.houseRTP,
      message: `House RTP set to ${(numRtp * 100).toFixed(1)}%!`,
    });
  });

  app.post('/api/admin/cycle-override', requireAdminAuth, (req, res) => {
    const { phase } = req.body; // 'COLLECTION' | 'GOLDEN_PAYOUT' | 'ADMIN_PROFIT' | 'PLAYER_WIN' | null
    if (phase !== 'COLLECTION' && phase !== 'GOLDEN_PAYOUT' && phase !== 'ADMIN_PROFIT' && phase !== 'PLAYER_WIN' && phase !== null) {
      return res.status(400).json({ error: 'Invalid phase override. Must be COLLECTION, GOLDEN_PAYOUT, or null.' });
    }
    gameEngine.forcedPhaseOverride = phase;
    const cycleStatus = gameEngine.getCycleStatus();

    // Broadcast instant cycle update to all connected clients and admin views
    io.emit('game_cycle_update', cycleStatus);

    let message = 'Automatic Random Loop resumed (Self-running by default)!';
    if (phase === 'COLLECTION' || phase === 'ADMIN_PROFIT') {
      message = 'FORCE COLLECTION PHASE ACTIVATED! Multipliers instantly locked between 1.01x and 1.85x.';
    } else if (phase === 'GOLDEN_PAYOUT' || phase === 'PLAYER_WIN') {
      message = 'FORCE GOLDEN PAYOUT ACTIVATED! Multipliers instantly locked between 3.00x and 50.00x+.';
    }

    res.json({
      success: true,
      cycle: cycleStatus,
      message,
    });
  });

  app.post('/api/admin/set-daily-target', requireAdminAuth, (req, res) => {
    const { target } = req.body;
    const num = parseFloat(target);
    if (!num || num <= 0) {
      return res.status(400).json({ error: 'Invalid daily profit target.' });
    }
    gameEngine.targetDailyProfit = num;
    res.json({
      success: true,
      targetDailyProfit: gameEngine.targetDailyProfit,
      cycle: gameEngine.getCycleStatus(),
      message: `Daily profit target set to ${num.toLocaleString()} BDT!`,
    });
  });

  app.post('/api/admin/approve-deposit', requireAdminAuth, (req, res) => {
    const { depositId } = req.body;
    const deposit = inMemoryDb.userDeposits.find((d) => d.id === depositId);
    if (!deposit) {
      return res.status(404).json({ error: 'Deposit not found.' });
    }

    if (deposit.status === 'APPROVED') {
      return res.status(400).json({ error: 'Deposit is already approved.' });
    }

    deposit.status = 'APPROVED';
    deposit.matchedAt = Date.now();

    const user = inMemoryDb.getUser(deposit.userId);
    const updatedUser = inMemoryDb.updateUser(deposit.userId, {
      balance: user.balance + deposit.amount,
      depositedAmount: (user.depositedAmount || 0) + deposit.amount,
    });
    inMemoryDb.recordDeposit(deposit.amount);

    const turnover = calculateTurnoverStatus(updatedUser);
    io.emit('wallet_updated', {
      userId: user.userId,
      user: updatedUser,
      turnover,
      notification: `Admin approved your deposit of ${deposit.amount} BDT!`,
    });

    res.json({
      success: true,
      deposit,
      user: updatedUser,
      message: `Deposit ${deposit.trxId} of ${deposit.amount} BDT approved!`,
    });
  });

  // Google Gemini AI Chatbot Support ("Kophbe AI")
  app.post('/api/ai/chat', async (req, res) => {
    const { prompt, userId, history } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required.' });
    }

    try {
      const reply = await askKophbeAI(prompt, userId, history);
      res.json({ reply });
    } catch (err: any) {
      console.error('Gemini chat error:', err);
      res.status(500).json({ error: 'Failed to generate response from Kophbe AI.' });
    }
  });

  // --- Vite / Static Middleware ---
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`[Official Crush Server] Running at http://localhost:${PORT}`);
  });
}

startServer();
