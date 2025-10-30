/**
 * ticket-booking-system/app.js
 *
 * Simple Express server that demonstrates a seat-locking mechanism
 * for concurrent booking scenarios (in-memory).
 *
 * Endpoints:
 *  - GET  /seats                         -> list seats and their state
 *  - POST /lock                          -> lock one or more seats (returns lock token)
 *  - POST /reserve                       -> finalize reservation using lock token
 *  - POST /unlock                        -> release a lock (optional)
 *
 * Lock rules:
 *  - When a lock is created it has a TTL (lockTimeoutMs).
 *  - Another user cannot lock a seat that is currently locked (unless expired).
 *  - Reservation must present the exact token that locked the seats.
 *
 * NOTE: in-memory locks only work for a single Node process. For real distributed concurrency,
 * use a distributed store such as Redis and a proper distributed lock algorithm.
 */

const express = require("express");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ------------------------
// Configuration
// ------------------------
const SEAT_COUNT = 30;            // total seats available (1..SEAT_COUNT)
const LOCK_TIMEOUT_MS = 30_000;   // 30 seconds default lock TTL
const LOCK_CLEANUP_MS = 5_000;    // cleanup expired locks every 5s

// ------------------------
// In-memory data structures
// ------------------------

// seats: map seatId -> { id, reservedBy: userId|null, reservedAt: timestamp|null }
const seats = new Map();

// locks: map lockToken -> { token, userId, seatIds: [], expiresAt: timestamp }
const locks = new Map();

// seatToLock: map seatId -> lockToken (so we can quickly check who locked a seat)
const seatToLock = new Map();

// initialize seats
for (let i = 1; i <= SEAT_COUNT; i++) {
  seats.set(i, { id: i, reservedBy: null, reservedAt: null });
}

// ------------------------
// Helpers
// ------------------------
function nowTs() {
  return Date.now();
}

function isLockExpired(lock) {
  return nowTs() > lock.expiresAt;
}

/**
 * Try to acquire locks for a set of seatIds for a given user.
 * Returns { success: boolean, token?: string, conflicts?: [{seatId, lockedBy}] , message? }
 */
function acquireLock(userId, seatIds, lockTimeoutMs = LOCK_TIMEOUT_MS) {
  const conflicts = [];

  // Check for conflicts: seat reserved or currently locked by someone else (and not expired)
  for (const sid of seatIds) {
    const seat = seats.get(sid);
    if (!seat) {
      return { success: false, message: `Seat ${sid} does not exist.` };
    }
    if (seat.reservedBy) {
      conflicts.push({ seatId: sid, reason: "already_reserved", reservedBy: seat.reservedBy });
      continue;
    }
    const existingLockToken = seatToLock.get(sid);
    if (existingLockToken) {
      const existingLock = locks.get(existingLockToken);
      if (existingLock && !isLockExpired(existingLock) && existingLock.userId !== userId) {
        conflicts.push({ seatId: sid, reason: "locked", lockedBy: existingLock.userId });
      }
    }
  }

  if (conflicts.length > 0) {
    return { success: false, conflicts };
  }

  // All seats are available (or they are locked by same user and lock not expired) => create token
  const token = uuidv4();
  const expiresAt = nowTs() + lockTimeoutMs;
  const lockObj = { token, userId, seatIds: [...seatIds], expiresAt };

  // Register lock and map seats
  locks.set(token, lockObj);
  for (const sid of seatIds) {
    seatToLock.set(sid, token);
  }

  return { success: true, token, expiresAt };
}

/**
 * Reserve seats using a valid lock token. Returns { success, message }
 */
function reserveWithToken(token) {
  const lock = locks.get(token);
  if (!lock) return { success: false, message: "Invalid lock token." };
  if (isLockExpired(lock)) {
    // cleanup expired lock
    releaseLock(token);
    return { success: false, message: "Lock expired." };
  }

  // Check seats are still available (should be, but sanity check)
  for (const sid of lock.seatIds) {
    const seat = seats.get(sid);
    if (!seat) return { success: false, message: `Seat ${sid} does not exist.` };
    if (seat.reservedBy) {
      return { success: false, message: `Seat ${sid} already reserved.` };
    }
    const mappedToken = seatToLock.get(sid);
    if (mappedToken !== token) {
      return { success: false, message: `Seat ${sid} locked by another token.` };
    }
  }

  // Mark seats reserved
  for (const sid of lock.seatIds) {
    const seat = seats.get(sid);
    seat.reservedBy = lock.userId;
    seat.reservedAt = nowTs();
    seats.set(sid, seat);
    seatToLock.delete(sid);
  }

  // Remove lock
  locks.delete(token);

  return { success: true, reservedSeats: lock.seatIds };
}

/**
 * Release a lock voluntarily.
 */
function releaseLock(token) {
  const lock = locks.get(token);
  if (!lock) return false;
  for (const sid of lock.seatIds) {
    // Only clear mapping if it points to this token
    if (seatToLock.get(sid) === token) {
      seatToLock.delete(sid);
    }
  }
  locks.delete(token);
  return true;
}

/**
 * Periodic cleanup for expired locks
 */
function cleanupExpiredLocks() {
  const expired = [];
  for (const [token, lock] of locks.entries()) {
    if (isLockExpired(lock)) expired.push(token);
  }
  for (const token of expired) {
    releaseLock(token);
  }
}

// run cleanup interval
setInterval(cleanupExpiredLocks, LOCK_CLEANUP_MS);

// ------------------------
// Routes
// ------------------------

/**
 * GET /seats
 * Query params:
 *  - includeLocks=true  -> include lock info in the response
 *
 * Returns summary of seats (id, reservedBy, lockUser if any, lockExpiresAt if any)
 */
app.get("/seats", (req, res) => {
  const includeLocks = req.query.includeLocks === "true";
  const list = [];

  for (const [id, seat] of seats.entries()) {
    const entry = {
      id: seat.id,
      reservedBy: seat.reservedBy,
      reservedAt: seat.reservedAt ? new Date(seat.reservedAt).toISOString() : null
    };
    if (includeLocks) {
      const token = seatToLock.get(id);
      if (token) {
        const lock = locks.get(token);
        if (lock && !isLockExpired(lock)) {
          entry.lockedBy = lock.userId;
          entry.lockExpiresAt = new Date(lock.expiresAt).toISOString();
          entry.lockToken = token; // include token so testers can use it (in real app only return token to locker)
        } else {
          // stale mapping - cleanup
          seatToLock.delete(id);
        }
      }
    }
    list.push(entry);
  }

  res.json({ seats: list });
});

/**
 * POST /lock
 * Body: { userId: string, seatIds: [1,2,...], lockTimeoutMs?: number }
 *
 * Tries to lock seatIds for userId. Returns { success, token, expiresAt } on success.
 * On conflict returns { success: false, conflicts: [...] }
 */
app.post("/lock", (req, res) => {
  const { userId, seatIds, lockTimeoutMs } = req.body;
  if (!userId || !Array.isArray(seatIds) || seatIds.length === 0) {
    return res.status(400).json({ success: false, message: "userId and seatIds[] are required." });
  }

  // Validate seat ids numbers
  const normalized = seatIds.map(Number).filter(n => Number.isInteger(n));
  const result = acquireLock(userId, normalized, lockTimeoutMs || LOCK_TIMEOUT_MS);

  if (!result.success) {
    return res.status(409).json(result);
  }

  return res.status(201).json({ success: true, token: result.token, expiresAt: new Date(result.expiresAt).toISOString() });
});

/**
 * POST /reserve
 * Body: { token: string }
 *
 * Finalizes reservation for seats that were locked by that token.
 */
app.post("/reserve", (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ success: false, message: "token is required" });

  const result = reserveWithToken(token);
  if (!result.success) {
    return res.status(409).json(result);
  }

  return res.json({ success: true, reservedSeats: result.reservedSeats });
});

/**
 * POST /unlock
 * Body: { token: string }
 *
 * Voluntarily release a previously acquired lock (useful in UI/back button)
 */
app.post("/unlock", (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ success: false, message: "token is required" });
  const ok = releaseLock(token);
  if (!ok) return res.status(404).json({ success: false, message: "lock not found" });
  return res.json({ success: true, message: "lock released" });
});

/**
 * GET /locks
 * Returns current active locks (for debug/testing)
 */
app.get("/locks", (req, res) => {
  const list = [];
  for (const [token, lock] of locks.entries()) {
    list.push({
      token,
      userId: lock.userId,
      seatIds: lock.seatIds,
      expiresAt: new Date(lock.expiresAt).toISOString()
    });
  }
  res.json({ locks: list });
});

// Default route
app.get("/", (req, res) => {
  res.send("Ticket Booking System with Seat Locking (sample API). See README for usage.");
});

// Start server
app.listen(PORT, () => {
  console.log(`Ticket booking API running on port ${PORT}`);
});
