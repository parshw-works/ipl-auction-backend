// =========================================================================
// GLOBAL PROCESS ERROR SHIELDS (FATAL CRASH PREVENTION FOR RENDER)
// =========================================================================
process.on('uncaughtException', (err) => {
  console.error('[FATAL CRASH SHIELD] Uncaught Exception caught:', err.stack || err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL CRASH SHIELD] Unhandled Rejection at:', promise, 'reason:', reason);
});

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Dedicated Render Keep-Alive / Health Endpoint
app.get('/health', (req, res) => res.status(200).send('OK'));

// Cache prevention middleware to ensure browser always loads latest code
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  next();
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  maxAge: 0
}));

// Load static players dataset strictly on boot as immutable reference array
const playersFilePath = path.join(__dirname, 'players.json');
let playersDataset = [];
try {
  const rawData = fs.readFileSync(playersFilePath, 'utf-8');
  playersDataset = JSON.parse(rawData);
  console.log(`[IPL SERVER] Successfully loaded ${playersDataset.length} players with ratings.`);
} catch (err) {
  console.error('[IPL SERVER] Error loading players.json:', err.message);
  process.exit(1);
}

// In-Memory Storage for Active Auction Matches strictly in RAM
const rooms = new Map();

// Session Registry: sessionToken -> { roomId, teamId, managerName, socketId }
const sessionRegistry = new Map();

// Universal room code sanitizer: strips '#', spaces, and special characters
function sanitizeRoomCode(code) {
  if (!code) return '';
  return String(code).replace(/[^a-zA-Z0-9]/g, '').trim().toUpperCase();
}

// Universal Room Getter: Works whether 'rooms' is a Map or an Object, handles casing and symbols
function getRoom(rawCode) {
  if (!rawCode) return null;
  const clean = sanitizeRoomCode(rawCode);
  if (!clean) return null;

  // 1. If rooms is a Map
  if (typeof rooms.get === 'function') {
    const r = rooms.get(clean) || rooms.get(rawCode);
    if (r) return r;
  }

  // 2. If rooms is a plain Object
  if (rooms && typeof rooms === 'object') {
    const r = rooms[clean] || rooms[rawCode];
    if (r) return r;
  }

  // 3. Case-insensitive fallback across all active rooms
  const allEntries = typeof rooms.entries === 'function' ? Array.from(rooms.entries()) : Object.entries(rooms);
  for (const [k, v] of allEntries) {
    if (sanitizeRoomCode(k) === clean) {
      return v;
    }
  }

  return null;
}

// Universal Room Setter: Dual-writes so both Map.get and obj[code] lookups always succeed
function saveRoom(rawCode, roomData) {
  const clean = sanitizeRoomCode(rawCode);
  if (typeof rooms.set === 'function') {
    rooms.set(clean, roomData);
  }
  rooms[clean] = roomData;
}

// Universal Room Deleter: Cleans up both Map and Object representations
function deleteRoom(rawCode) {
  const clean = sanitizeRoomCode(rawCode);
  if (typeof rooms.delete === 'function') {
    rooms.delete(clean);
    rooms.delete(rawCode);
  }
  if (rooms && typeof rooms === 'object') {
    delete rooms[clean];
    delete rooms[rawCode];
  }
}

function generateSessionToken() {
  return crypto.randomBytes(24).toString('hex');
}

function sanitizeName(name, defaultName = 'Player') {
  if (!name || typeof name !== 'string') return defaultName;
  const cleaned = name.replace(/[<>&"'\/]/g, '').trim();
  if (cleaned.length < 2) return defaultName;
  return cleaned.substring(0, 20);
}

// Fisher-Yates array shuffle for randomized auction player sequence
function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = array[i];
    array[i] = array[j];
    array[j] = temp;
  }
  return array;
}

// Franchise configurations with local vector logos
const IPL_TEAMS = [
  { id: 'CSK', name: 'Chennai Super Kings', color: '#FDB913', textColor: '#000000', logo: '/logos/CSK.svg', icon: '🦁' },
  { id: 'RCB', name: 'Royal Challengers Bengaluru', color: '#DA1717', textColor: '#ffffff', logo: '/logos/RCB.svg', icon: '👑' },
  { id: 'MI', name: 'Mumbai Indians', color: '#004BA0', textColor: '#ffffff', logo: '/logos/MI.svg', icon: '🌪️' },
  { id: 'KKR', name: 'Kolkata Knight Riders', color: '#3A225D', textColor: '#ffffff', logo: '/logos/KKR.svg', icon: '⚔️' },
  { id: 'SRH', name: 'Sunrisers Hyderabad', color: '#F26522', textColor: '#ffffff', logo: '/logos/SRH.svg', icon: '🦅' },
  { id: 'RR', name: 'Rajasthan Royals', color: '#EA1A85', textColor: '#ffffff', logo: '/logos/RR.svg', icon: '🛡️' },
  { id: 'DC', name: 'Delhi Capitals', color: '#17449E', textColor: '#ffffff', logo: '/logos/DC.svg', icon: '🐯' },
  { id: 'LSG', name: 'Lucknow Super Giants', color: '#00BFFF', textColor: '#000000', logo: '/logos/LSG.svg', icon: '🪽' },
  { id: 'GT', name: 'Gujarat Titans', color: '#1B2133', textColor: '#ffffff', logo: '/logos/GT.svg', icon: '⚡' },
  { id: 'PBKS', name: 'Punjab Kings', color: '#D71920', textColor: '#ffffff', logo: '/logos/PBKS.svg', icon: '🦁' }
];

// Bid increment rules
function calculateIncrement(currentBid) {
  if (currentBid < 10000000) {
    return 2000000; // < 1 Cr: +20 Lakhs
  } else if (currentBid < 50000000) {
    return 2500000; // 1 Cr - 5 Cr: +25 Lakhs
  } else if (currentBid < 100000000) {
    return 5000000; // 5 Cr - 10 Cr: +50 Lakhs
  } else {
    return 10000000; // > 10 Cr: +1 Cr
  }
}

// 5-character room code generator
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = '';
    for (let i = 0; i < 5; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
  } while (getRoom(code));
  return code;
}

// Retention cost slabs
const RETENTION_COSTS = [180000000, 140000000, 110000000, 180000000, 140000000];

// Controlled host wrap-up threshold check
function canConcludeEarly(room) {
  if (room.status !== 'AUCTION') return false;
  const teams = Object.values(room.teams || {});
  if (teams.length === 0) return false;
  const minRequired = (room.settings && room.settings.minSquadSize) || 15;
  for (const team of teams) {
    let count = (team.squad ? team.squad.length : 0);
    if (room.currentPlayer && room.highestBidder && room.highestBidder.teamId === team.franchiseId) {
      count += 1;
    }
    if (count < minRequired) {
      return false;
    }
  }
  return true;
}

// Victory scoring formula: Team Total Points = sum of roster player ratings
function calculateStandings(room) {
  const teams = Object.values(room.teams || {});
  const scoredTeams = teams.map(t => {
    const totalPoints = (t.squad || []).reduce((sum, p) => sum + (p.rating || 75), 0);
    const avgRating = (t.squad && t.squad.length > 0) ? (totalPoints / t.squad.length).toFixed(1) : '0.0';
    return {
      ...t,
      teamId: t.franchiseId,
      teamName: t.name,
      remainingPurse: t.purse,
      logo: t.logo || `/logos/${t.franchiseId}.svg`,
      color: t.color || '#334155',
      totalPoints,
      avgRating: Number(avgRating),
      squadCount: (t.squad ? t.squad.length : 0)
    };
  });

  // Sort: descending by totalPoints; tie breaker: descending by remaining purse
  scoredTeams.sort((a, b) => {
    if (b.totalPoints !== a.totalPoints) {
      return b.totalPoints - a.totalPoints;
    }
    return (b.remainingPurse || b.purse) - (a.remainingPurse || a.purse);
  });

  scoredTeams.forEach((t, index) => {
    t.rank = index + 1;
  });

  return scoredTeams;
}

// Match End Engine: Transition Sequence
function triggerAuctionEndSequence(room, reason) {
  if (room.isConcluding || room.status === 'FINISHED') return;
  room.isConcluding = true;
  room.phase = 'CONCLUDED';
  clearRoomTimer(room);
  if (typeof RoomTimerManager !== 'undefined') {
    RoomTimerManager.clear(room);
  }

  // Safety resolve for active lot if still present (H10)
  if (room.currentPlayer) {
    const player = room.currentPlayer;
    if (room.highestBidder) {
      const winningTeam = room.teams[room.highestBidder.teamId];
      if (winningTeam) {
        winningTeam.purse -= room.currentBid;
        winningTeam.squad.push({
          ...player,
          finalPrice: room.currentBid,
          acquiredVia: 'AUCTION'
        });
        if (player.isOverseas) {
          winningTeam.overseasCount = (winningTeam.overseasCount || 0) + 1;
        }
        winningTeam.squadCount = winningTeam.squad.length;
        addRoomLog(
          room,
          `🔨 SOLD! ${player.name} sold to ${winningTeam.name} (${winningTeam.franchiseId}) for ₹${(room.currentBid / 10000000).toFixed(2)} Cr upon match conclusion!`,
          'sold',
          { playerName: player.name, teamName: winningTeam.name, teamId: winningTeam.franchiseId, price: room.currentBid, rating: player.rating }
        );
        io.to(room.code).emit('player_sold', {
          player,
          team: winningTeam,
          price: room.currentBid
        });
      }
    } else {
      room.unsoldPlayers.push(player);
      addRoomLog(room, `❌ UNSOLD! ${player.name} went unsold as auction concluded.`, 'unsold');
      io.to(room.code).emit('player_unsold', { player });
    }
    room.currentPlayer = null;
    room.highestBidder = null;
  }

  addRoomLog(room, `🏁 ${reason || 'Auction concluded!'} Tallying final squad points...`, 'finish');
  io.to(room.code).emit('auction_concluding', {
    reason: reason || 'Auction concluded',
    countdown: 5
  });

  setTimeout(() => {
    room.status = 'FINISHED';
    room.phase = 'CONCLUDED';
    room.currentPlayer = null;
    room.highestBidder = null;
    room.isConcluding = false;
    const standings = calculateStandings(room);
    room.standings = standings;

    addRoomLog(room, `🏆 CHAMPIONSHIP DECIDED! Check the Grand Finale Podium.`, 'finish');
    io.to(room.code).emit('auction_concluded', {
      standings,
      roomState: sanitizeRoomState(room)
    });
    broadcastRoomUpdate(room.code);
  }, 5000);
}

// Trigger B check: Squad capacity / financial saturation
function checkCapacityAndFinanceEndCondition(room) {
  const teams = Object.values(room.teams || {});
  if (teams.length === 0) return false;
  const maxSquad = (room.settings && room.settings.maxSquadSize) || 25;
  
  let minBasePrice = 20000000;
  for (let i = room.auctionIndex + 1; i < room.playerPool.length; i++) {
    if (room.playerPool[i].basePrice < minBasePrice) {
      minBasePrice = room.playerPool[i].basePrice;
    }
  }

  for (const team of teams) {
    const hasSlot = (team.squad ? team.squad.length : 0) < maxSquad;
    const hasPurse = team.purse >= minBasePrice;
    if (hasSlot && hasPurse) {
      return false; // at least one team has slots and funds left
    }
  }
  return true;
}

function sanitizeRoomState(room) {
  const foldedList = (room.currentLot && Array.isArray(room.currentLot.foldedTeamIds))
    ? [...room.currentLot.foldedTeamIds]
    : (Array.isArray(room.foldedTeams) ? [...room.foldedTeams] : Array.from(room.foldedTeams || []));
  const membersList = room.members ? Array.from(room.members.values()).map((m, idx) => ({
    memberId: 'm_' + (idx + 1),
    displayName: m.playerName,
    teamId: m.teamId,
    role: m.role,
    isOnline: !!m.isOnline,
    isHost: m.playerId === room.hostPlayerId
  })) : [];
  const teamList = Object.values(room.teams || {}).map(t => {
    const copy = { ...t };
    delete copy.sessionToken;
    delete copy.ownerPlayerId;
    return copy;
  });
  const requiredFolds = teamList.length ? (room.highestBidder ? Math.max(teamList.length - 1, 1) : Math.max(teamList.length, 1)) : 1;
  return {
    code: room.code,
    hostId: room.hostId,
    phase: room.phase || (room.isStarted ? 'BIDDING' : 'LOBBY'),
    lotVersion: room.lotVersion || 1,
    members: membersList,
    status: room.status,
    isStarted: !!room.isStarted,
    isConcluding: !!room.isConcluding,
    canConcludeEarly: canConcludeEarly(room),
    settings: room.settings,
    teams: teamList,
    currentPlayer: room.currentPlayer,
    currentLot: room.currentLot || null,
    currentBid: room.currentBid,
    highestBidder: room.highestBidder,
    timerSeconds: room.timerSeconds,
    isTimerRunning: room.isTimerRunning,
    auctionIndex: room.auctionIndex,
    totalPlayers: room.playerPool.length,
    recentLogs: room.recentLogs.slice(-30),
    canUndoSkip: room.skipHistory.length > 0,
    unclaimedTeams: IPL_TEAMS.filter(t => !room.teams[t.id]),
    foldedTeams: foldedList,
    foldedCount: foldedList.length,
    requiredFolds: requiredFolds,
    standings: room.standings || null,
    spectatorsCount: room.spectators ? (room.spectators.size || Object.keys(room.spectators).length) : 0,
    decibelMeter: room.decibelMeter || {}
  };
}

function getTeamForSocket(room, socket, sessionToken = null) {
  if (!room || !room.teams) return null;
  const token = (socket && socket.data && socket.data.sessionToken) || sessionToken;
  const pId = socket && socket.data && socket.data.playerId;
  for (const team of Object.values(room.teams)) {
    if ((token && team.sessionToken === token) || 
        (pId && team.ownerPlayerId === pId) || 
        (socket && team.socketId === socket.id)) {
      return team;
    }
  }
  return null;
}

function getVerifiedMember(room, socket, payloadToken = null) {
  if (!room || !room.members) return null;
  const token = (socket && socket.data && socket.data.sessionToken) || payloadToken;
  if (!token) return null;
  const membersArray = typeof room.members.values === 'function' ? Array.from(room.members.values()) : Object.values(room.members);
  for (const m of membersArray) {
    if (m.sessionToken === token) {
      return m;
    }
  }
  return null;
}

function broadcastRoomUpdate(roomCode) {
  const room = getRoom(roomCode);
  if (!room) return;
  io.to(room.code || roomCode).emit('room_update', sanitizeRoomState(room));
}

function addRoomLog(room, message, type = 'info', meta = null) {
  const timestamp = Date.now();
  const entry = {
    id: 'log_' + timestamp + '_' + Math.random().toString(36).substring(2, 6),
    timestamp,
    time: new Date(timestamp).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    message,
    type,
    meta
  };
  room.recentLogs.push(entry);
  if (room.recentLogs.length > 100) room.recentLogs.shift();
  io.to(room.code).emit('new_log', entry);
}

// Singleton RoomTimerManager: centralizes and hardens timer lifecycle against timer leaks
class RoomTimerManager {
  static startCountdown(room, durationSeconds, onTick, onComplete) {
    this.clear(room);
    room.timerRemaining = durationSeconds;
    room.timerSeconds = durationSeconds;
    room.timerActive = true;
    room.isTimerRunning = true;
    if (onTick) onTick(room.timerSeconds);

    room.timerInterval = setInterval(() => {
      room.timerRemaining -= 1;
      room.timerSeconds = room.timerRemaining;
      if (onTick) onTick(room.timerRemaining);

      if (room.timerRemaining <= 0) {
        RoomTimerManager.clear(room);
        if (onComplete) onComplete();
      }
    }, 1000);
  }

  static clear(room) {
    if (room && room.timerInterval) {
      clearInterval(room.timerInterval);
      room.timerInterval = null;
    }
    if (room) {
      room.timerActive = false;
      room.isTimerRunning = false;
    }
  }
}

// Backward-compatibility wrapper
function clearRoomTimer(room) {
  RoomTimerManager.clear(room);
}

function startCountdown(room) {
  RoomTimerManager.startCountdown(
    room,
    15,
    (seconds) => {
      io.to(room.code).emit('timer_tick', { seconds, isRunning: true });
    },
    () => {
      handlePlayerSoldOrUnsold(room);
    }
  );
}

// Strict Fold Consensus Resolution (Bug 1 Fix)
function resolveLotSold(room, teamId, price) {
  room.phase = 'HAMMER';
  clearRoomTimer(room);
  handlePlayerSoldOrUnsold(room);
  return { handled: true, outcome: 'sold' };
}

function resolveLotUnsold(room, reason) {
  room.phase = 'HAMMER';
  clearRoomTimer(room);
  handlePlayerSoldOrUnsold(room);
  return { handled: true, outcome: 'unsold' };
}

function evaluateFoldConsensus(room) {
  const lot = room.currentLot;
  if (!lot || room.phase !== 'BIDDING' || room.status !== 'AUCTION') return { handled: false };

  const allTeamIds = Object.keys(room.teams || {});
  const folded = Array.isArray(lot.foldedTeamIds) ? lot.foldedTeamIds : (Array.isArray(room.foldedTeams) ? room.foldedTeams : []);
  const unfolded = allTeamIds.filter(id => !folded.includes(id));

  // SCENARIO 1: Opening bid exists, and ALL rival teams have folded -> SOLD immediately
  if (lot.hasOpeningBid && unfolded.length === 1 && unfolded[0] === lot.highestBidderTeamId) {
    clearRoomTimer(room);
    room.phase = 'HAMMER';
    addRoomLog(
      room,
      `⚡ Consensus reached! All rival franchises folded on ${room.currentPlayer?.name || lot.name}. Instant hammer!`,
      'announcement'
    );
    io.to(room.code).emit('all_teams_folded', {
      player: room.currentPlayer || lot,
      highestBidder: room.highestBidder
    });
    return resolveLotSold(room, lot.highestBidderTeamId, lot.currentBid);
  }

  // SCENARIO 2: No bids placed and ALL teams folded -> UNSOLD immediately
  if (!lot.hasOpeningBid && unfolded.length === 0) {
    clearRoomTimer(room);
    room.phase = 'HAMMER';
    addRoomLog(
      room,
      `⚡ All franchises passed on ${room.currentPlayer?.name || lot.name}. Instant unsold!`,
      'announcement'
    );
    return resolveLotUnsold(room, 'All teams passed with no bids.');
  }

  return { handled: false };
}

const evaluateLotConsensus = evaluateFoldConsensus;

function handlePlayerSoldOrUnsold(room) {
  const player = room.currentPlayer;
  if (!player) return;

  room.phase = 'HAMMER';
  RoomTimerManager.clear(room);

  if (room.highestBidder) {
    // SOLD!
    const winningTeam = room.teams[room.highestBidder.teamId];

    if (winningTeam) {
      winningTeam.purse -= room.currentBid;
      winningTeam.squad.push({
        ...player,
        finalPrice: room.currentBid,
        acquiredVia: 'AUCTION'
      });
      if (player.isOverseas) {
        winningTeam.overseasCount = (winningTeam.overseasCount || 0) + 1;
      }
      winningTeam.squadCount = winningTeam.squad.length;

      addRoomLog(
        room,
        `🔨 SOLD! ${player.name} sold to ${winningTeam.name} (${winningTeam.franchiseId}) for ₹${(room.currentBid / 10000000).toFixed(2)} Cr! [Rating: ${player.rating || 75}]`,
        'sold',
        { playerName: player.name, teamName: winningTeam.name, teamId: winningTeam.franchiseId, price: room.currentBid, rating: player.rating }
      );

      io.to(room.code).emit('player_sold', {
        player,
        team: winningTeam,
        price: room.currentBid
      });
    }
  } else {
    // UNSOLD!
    room.unsoldPlayers.push(player);
    addRoomLog(room, `❌ UNSOLD! ${player.name} went unsold at base price ₹${(player.basePrice / 10000000).toFixed(2)} Cr.`, 'unsold');
    io.to(room.code).emit('player_unsold', { player });
  }

  // Clear all lot folds immediately so no team remains locked during the transition
  if (room.currentLot) {
    room.currentLot.foldedTeamIds = [];
  }
  room.foldedTeams = [];
  if (room.teams) {
    for (const t of Object.values(room.teams)) {
      t.isFolded = false;
    }
  }

  // Check Trigger B: Squad capacity or financial saturation
  if (checkCapacityAndFinanceEndCondition(room)) {
    setTimeout(() => {
      triggerAuctionEndSequence(room, 'All participating teams have reached max squad capacity or exhausted purse limits!');
    }, 2500);
    return;
  }

  // 3-second delay before moving to next player (Hammer Window guard)
  setTimeout(() => {
    room.phase = 'TRANSITION';
    advanceToNextPlayer(room);
  }, 3000);
}

function advanceToNextPlayer(room) {
  if (!getRoom(room.code)) return;

  room.auctionIndex += 1;
  if (room.auctionIndex < room.playerPool.length) {
    const nextPlayer = room.playerPool[room.auctionIndex];
    room.phase = 'BIDDING';
    room.lotVersion = 1;
    room.currentPlayer = nextPlayer;
    room.currentBid = nextPlayer.basePrice;
    room.highestBidder = null;
    room.openingBidPlaced = false;
    room.timerSeconds = 15;
    room.isTimerRunning = false;
    room.foldedTeams = [];

    // A. Initialize fresh lot with null leader and empty array
    room.currentLot = {
      ...nextPlayer,
      player: nextPlayer,
      currentBid: nextPlayer.basePrice,
      basePrice: nextPlayer.basePrice,
      highestBidderTeamId: null,
      highestBidder: null,
      hasOpeningBid: false,
      lotVersion: 1,
      auctionIndex: room.auctionIndex,
      totalPlayers: room.playerPool.length,
      foldedTeamIds: [] // MUST be an Array so it serializes cleanly over Socket.IO
    };

    // B. Clear folded flag on all team objects in the room
    if (room.teams) {
      Object.values(room.teams).forEach(team => {
        team.isFolded = false;
      });
    }
    startCountdown(room);

    // C. Set phase to BIDDING and broadcast
    io.to(room.code).emit('new_lot_started', {
      player: nextPlayer,
      lot: room.currentLot,
      teams: Object.values(room.teams).map(t => {
        const copy = { ...t };
        delete copy.sessionToken;
        delete copy.ownerPlayerId;
        return copy;
      })
    });

    addRoomLog(
      room,
      `📢 Next on hammer: ${nextPlayer.name} (${nextPlayer.role}, ${nextPlayer.isOverseas ? '✈️ Overseas' : '🇮🇳 Indian'}) - Base: ₹${(nextPlayer.basePrice / 10000000).toFixed(2)} Cr [Rating: ${nextPlayer.rating || 75}]`,
      'announcement'
    );

    // Check for player eligibility across all participating teams
    const maxSquad = (room.settings && room.settings.maxSquadSize) || 25;
    const maxOS = (room.settings && room.settings.maxOverseas) || 8;
    const basePrice = nextPlayer.basePrice;

    // Detect if ANY team is legally able to bid on this player
    let eligibleBidders = 0;
    for (const team of Object.values(room.teams)) {
      const squadLen = team.squad ? team.squad.length : 0;
      const osCount = team.overseasCount || 0;
      const canTakeSquad = squadLen < maxSquad;
      const canTakeOS = !nextPlayer.isOverseas || osCount < maxOS;
      const canAfford = team.purse >= basePrice;

      if (canTakeSquad && canTakeOS && canAfford) {
        eligibleBidders += 1;
      }
    }

    if (eligibleBidders === 0 && Object.keys(room.teams).length > 0) {
      addRoomLog(
        room,
        `⚠️ Deadlock prevented: No connected franchise can legally bid on ${nextPlayer.name} (Quota/Purse limits). Auto-passing unsold.`,
        'warning'
      );
      // Pass player as unsold immediately and proceed
      RoomTimerManager.clear(room);
      handlePlayerSoldOrUnsold(room);
      return;
    }

    broadcastRoomUpdate(room.code);
  } else {
    // Trigger A: Player pool exhaustion
    triggerAuctionEndSequence(room, 'All players in auction pool have been presented!');
  }
}

// Socket.IO Connection
io.on('connection', (socket) => {
  // 1. Create Room
  socket.on('create_room', (data, callback) => {
    try {
      const { 
        initialPurse = 1000000000, 
        maxSquadSize = 25, 
        minSquadSize = 15,
        maxOverseas = 8, 
        retentionsAllowed = 2,
        managerName = 'Host'
      } = data || {};
      const roomCode = sanitizeRoomCode(generateRoomCode());
      const token = generateSessionToken();
      const pId = 'usr_' + crypto.randomBytes(6).toString('hex');
      const mName = sanitizeName(managerName, 'Host');

      // Clone and shuffle players pool for randomized presentation
      const playerPool = shuffleArray(JSON.parse(JSON.stringify(playersDataset)));

      const decibelMap = {};
      IPL_TEAMS.forEach(t => { decibelMap[t.id] = 50; });

      // Enforce strict settings bounds defense
      const clampedMaxSquad = Math.min(Math.max(Number(maxSquadSize) || 25, 15), 25);
      const clampedMinSquad = Math.min(Math.max(Number(minSquadSize) || 15, 10), clampedMaxSquad);
      const clampedPurse = Math.min(Math.max(Number(initialPurse) || 1000000000, 200000000), 2000000000); // 20 Cr to 200 Cr
      const clampedOverseas = Math.min(Math.max(Number(maxOverseas) || 8, 4), 8); // 4 to 8
      const clampedRetentions = Math.min(Math.max(Number(retentionsAllowed) || 0, 0), 4); // 0 to 4

      const newRoom = {
        code: roomCode,
        hostId: socket.id,
        hostPlayerId: pId,
        status: 'LOBBY',
        phase: 'LOBBY',
        lotVersion: 1,
        isStarted: false,
        isConcluding: false,
        settings: {
          initialPurse: clampedPurse,
          maxSquadSize: clampedMaxSquad,
          minSquadSize: clampedMinSquad,
          maxOverseas: clampedOverseas,
          retentionsAllowed: clampedRetentions
        },
        members: new Map(),
        teams: {}, // Object keyed strictly by franchise ID ('CSK', 'MI', etc.)
        spectators: new Map(),
        decibelMeter: decibelMap,
        playerPool,
        unsoldPlayers: [],
        skipHistory: [],
        foldedTeams: [],
        currentLot: null,
        auctionIndex: -1,
        currentPlayer: null,
        currentBid: 0,
        highestBidder: null,
        timerSeconds: 15,
        isTimerRunning: false,
        timerInterval: null,
        recentLogs: [],
        standings: null
      };

      // Register host member
      const hostMember = {
        playerId: pId,
        playerName: mName,
        sessionToken: token,
        teamId: null,
        role: 'manager',
        socketId: socket.id,
        isOnline: true,
        disconnectTimeout: null
      };
      newRoom.members.set(pId, hostMember);
      newRoom.members[pId] = hostMember;

      saveRoom(roomCode, newRoom);
      socket.join(roomCode);
      socket.roomCode = roomCode;
      socket.playerId = pId;
      socket.data = socket.data || {};
      socket.data.sessionToken = token;
      socket.data.playerId = pId;

      sessionRegistry.set(token, {
        roomId: roomCode,
        playerId: pId,
        teamId: null,
        managerName: mName,
        socketId: socket.id,
        role: 'manager'
      });

      addRoomLog(newRoom, `Room created [${roomCode}]. Host joined.`);

      if (typeof callback === 'function') {
        callback({ success: true, roomCode, playerId: pId, sessionToken: token, roomState: sanitizeRoomState(newRoom) });
      }
    } catch (err) {
      if (typeof callback === 'function') callback({ success: false, error: err.message });
    }
  });

  // 2. Join Room (Universal Payload & Room Lookup)
  socket.on('join_room', (data, ...args) => {
    try {
      // 1. Flexible Payload Extraction
      let rawCode = '';
      let playerName = '';
      let playerId = '';
      let sessionToken = '';
      let asSpectator = false;
      let callback = null;

      // Extract callback if passed as trailing argument
      if (typeof args[args.length - 1] === 'function') {
        callback = args.pop();
      } else if (typeof data === 'function') {
        callback = data;
        data = null;
      }

      if (typeof data === 'string') {
        rawCode = data;
        playerName = typeof args[0] === 'string' ? args[0] : (args[0]?.playerName || args[0]?.managerName || '');
        playerId = args[1] || '';
        sessionToken = args[2] || '';
        asSpectator = !!args[3];
      } else if (data && typeof data === 'object') {
        rawCode = data.roomCode || data.roomId || data.code || '';
        playerName = data.playerName || data.managerName || data.name || '';
        playerId = data.playerId || '';
        sessionToken = data.sessionToken || '';
        asSpectator = !!data.asSpectator;
      }

      const cleanCode = sanitizeRoomCode(rawCode);
      const room = getRoom(cleanCode);

      // 2. Room Verification
      if (!room) {
        console.warn(`[JOIN FAILED] Room code not found: "${rawCode}" (Sanitized: "${cleanCode}")`);
        socket.emit('join_error', { message: 'Room not found. Check code.' });
        if (typeof callback === 'function') {
          callback({ success: false, error: 'Room not found. Check code.' });
        }
        return;
      }

      if (room.cleanupTimer) {
        clearTimeout(room.cleanupTimer);
        room.cleanupTimer = null;
      }

      // Check if this client has a valid existing session in this room
      if (sessionToken && room.members) {
        const membersList = typeof room.members.values === 'function' ? Array.from(room.members.values()) : Object.values(room.members);
        let existingMember = null;
        for (const m of membersList) {
          if (m.sessionToken === sessionToken) {
            existingMember = m;
            break;
          }
        }

        if (existingMember) {
          if (existingMember.disconnectTimeout) {
            clearTimeout(existingMember.disconnectTimeout);
            existingMember.disconnectTimeout = null;
          }
          existingMember.socketId = socket.id;
          existingMember.isOnline = true;
          if (playerName) {
            existingMember.playerName = sanitizeName(playerName, existingMember.playerName);
          }

          socket.join(cleanCode);
          socket.roomCode = cleanCode;
          socket.playerId = existingMember.playerId;
          socket.data = socket.data || {};
          socket.data.sessionToken = existingMember.sessionToken;
          socket.data.playerId = existingMember.playerId;
          socket.data.roomCode = cleanCode;

          if (existingMember.teamId && room.teams && room.teams[existingMember.teamId]) {
            const t = room.teams[existingMember.teamId];
            t.socketId = socket.id;
            t.managerName = existingMember.playerName;
            if (room.highestBidder && (room.highestBidder.teamId === t.franchiseId || room.highestBidder.playerId === existingMember.playerId)) {
              room.highestBidder.socketId = socket.id;
            }
          }

          sessionRegistry.set(existingMember.sessionToken, {
            roomId: cleanCode,
            playerId: existingMember.playerId,
            teamId: existingMember.teamId || null,
            managerName: existingMember.playerName,
            socketId: socket.id,
            role: existingMember.role
          });

          const sanitizedState = sanitizeRoomState(room);

          socket.emit('join_success', {
            roomCode: cleanCode,
            playerId: existingMember.playerId,
            sessionToken: existingMember.sessionToken,
            role: existingMember.role,
            playerName: existingMember.playerName,
            room: sanitizedState,
            roomState: sanitizedState
          });

          if (typeof callback === 'function') {
            callback({
              success: true,
              role: existingMember.role,
              playerId: existingMember.playerId,
              sessionToken: existingMember.sessionToken,
              roomState: sanitizedState
            });
          }
          broadcastRoomUpdate(cleanCode);
          return;
        }
      }

      // 3. Name Sanitization & Default Fallback
      const membersList = typeof room.members.values === 'function' ? Array.from(room.members.values()) : Object.values(room.members || {});
      let cleanName = sanitizeName(playerName, '');
      if (!cleanName || cleanName.length < 2) {
        cleanName = `Player ${membersList.length + 1}`;
      }

      // 4. Ensure Unique Name in this Room (friendly number suffix if taken)
      const existingMemberWithName = membersList.find(
        m => m.playerName && m.playerName.trim().toLowerCase() === cleanName.trim().toLowerCase() && m.playerId !== playerId
      );
      if (existingMemberWithName) {
        cleanName = `${cleanName} (${Math.floor(Math.random() * 90 + 10)})`;
      }

      // 5. Register Member
      if (!playerId) {
        playerId = 'usr_' + crypto.randomBytes(6).toString('hex');
      }
      if (!sessionToken) {
        sessionToken = generateSessionToken();
      }

      const isLobbyFull = Object.keys(room.teams || {}).length >= 10;
      const isAutoSpectator = !!asSpectator || room.isStarted || isLobbyFull;
      const role = isAutoSpectator ? 'spectator' : 'manager';

      const memberObj = {
        playerId,
        playerName: cleanName,
        sessionToken,
        teamId: null,
        role,
        socketId: socket.id,
        isOnline: true,
        disconnectTimeout: null
      };

      if (!room.members) room.members = new Map();
      if (typeof room.members.set === 'function') {
        room.members.set(playerId, memberObj);
      }
      room.members[playerId] = memberObj;

      socket.join(cleanCode);
      socket.roomCode = cleanCode;
      socket.playerId = playerId;
      socket.data = socket.data || {};
      socket.data.sessionToken = sessionToken;
      socket.data.playerId = playerId;
      socket.data.roomCode = cleanCode;

      if (isAutoSpectator) {
        if (!room.spectators) room.spectators = new Map();
        const specObj = {
          socketId: socket.id,
          playerId,
          managerName: cleanName,
          supportedTeam: null,
          sessionToken
        };
        if (typeof room.spectators.set === 'function') {
          room.spectators.set(socket.id, specObj);
        }
        room.spectators[socket.id] = specObj;
        addRoomLog(room, `👁️ ${cleanName} joined as Spectator.`);
      }

      sessionRegistry.set(sessionToken, {
        roomId: cleanCode,
        playerId,
        teamId: null,
        managerName: cleanName,
        socketId: socket.id,
        role
      });

      const sanitizedState = sanitizeRoomState(room);

      // 6. Return Success with sessionToken
      socket.emit('join_success', {
        roomCode: cleanCode,
        playerId,
        sessionToken,
        role,
        playerName: cleanName,
        room: sanitizedState,
        roomState: sanitizedState
      });

      if (typeof callback === 'function') {
        callback({
          success: true,
          role,
          playerId,
          sessionToken,
          roomState: sanitizedState
        });
      }

      // Notify all participants
      const currentMemberCount = typeof room.members.values === 'function' ? room.members.size : Object.keys(room.members).length;
      io.to(cleanCode).emit('player_joined', {
        playerId,
        playerName: cleanName,
        role,
        memberCount: currentMemberCount
      });

      broadcastRoomUpdate(cleanCode);
    } catch (err) {
      console.error('[ERROR in join_room]:', err);
      socket.emit('join_error', { message: 'Server error while joining room. Please try again.' });
      if (typeof callback === 'function') {
        callback({ success: false, error: 'Server error while joining room. Please try again.' });
      }
    }
  });

  // 2B. Reconnect Player / Resume Session (Strict sessionToken validation)
  const handleReconnect = ({ roomId, roomCode, sessionToken, managerName }, callback) => {
    try {
      const code = sanitizeRoomCode(roomId || roomCode || socket.roomCode || '');
      if (!code) return callback && callback({ success: false, error: 'Room code is required' });
      const room = getRoom(code);

      if (!room) {
        socket.emit('session_invalid', { message: 'Match room expired or not found.' });
        return callback && callback({ success: false, error: 'War Room session expired or not found.' });
      }

      const token = sessionToken || (socket.data && socket.data.sessionToken);
      if (!token) {
        socket.emit('session_invalid', { message: 'Session token required for reconnection.' });
        return callback && callback({ success: false, error: 'Session token required for reconnection.' });
      }

      if (room.cleanupTimer) {
        clearTimeout(room.cleanupTimer);
        room.cleanupTimer = null;
      }

      // Look up member EXCLUSIVELY by sessionToken
      let member = null;
      if (room.members) {
        const membersList = typeof room.members.values === 'function' ? Array.from(room.members.values()) : Object.values(room.members);
        for (const m of membersList) {
          if (m.sessionToken === token) {
            member = m;
            break;
          }
        }
      }

      if (!member) {
        socket.emit('session_invalid', { message: 'Session token not recognized in this room.' });
        return callback && callback({ success: false, error: 'Session not recognized in this room.' });
      }

      // Reconnection Match Found!
      if (member.disconnectTimeout) {
        clearTimeout(member.disconnectTimeout);
        member.disconnectTimeout = null;
      }
      member.socketId = socket.id;
      member.isOnline = true;
      if (managerName) member.playerName = sanitizeName(managerName, member.playerName);

      socket.join(code);
      socket.roomCode = code;
      socket.playerId = member.playerId;
      socket.data = socket.data || {};
      socket.data.sessionToken = token;
      socket.data.playerId = member.playerId;

      // Re-assign host if old host is disconnected
      if (!room.hostPlayerId) {
        room.hostPlayerId = member.playerId;
      }
      if (room.hostPlayerId === member.playerId) {
        room.hostId = socket.id;
      } else {
        const activeSockets = Array.from(io.sockets.adapter.rooms.get(code) || []);
        if (!room.hostId || !activeSockets.includes(room.hostId)) {
          room.hostId = socket.id;
          room.hostPlayerId = member.playerId;
        }
      }

      // Reclaim franchise team if member owns one
      let reclaimedTeam = null;
      if (member.teamId && room.teams && room.teams[member.teamId]) {
        const team = room.teams[member.teamId];
        if (team.ownerPlayerId === member.playerId) {
          team.socketId = socket.id;
          team.sessionToken = token;
          team.managerName = member.playerName;
          team.isHost = (room.hostPlayerId === member.playerId || socket.id === room.hostId);
          reclaimedTeam = team;

          if (room.highestBidder && (room.highestBidder.teamId === member.teamId || room.highestBidder.playerId === member.playerId)) {
            room.highestBidder.socketId = socket.id;
          }
        }
      }

      // CRITICAL GUARD: Never demote a manager to spectator
      const userRole = (member.role === 'manager' || reclaimedTeam) ? 'manager' : 'spectator';
      member.role = userRole;

      sessionRegistry.set(token, {
        roomId: code,
        playerId: member.playerId,
        teamId: reclaimedTeam ? reclaimedTeam.franchiseId : null,
        managerName: reclaimedTeam ? reclaimedTeam.managerName : member.playerName,
        socketId: socket.id,
        role: userRole
      });

      addRoomLog(
        room,
        `⚡ ${reclaimedTeam ? reclaimedTeam.managerName : member.playerName} reconnected & restored session.`,
        'info'
      );

      const franchiseRoster = reclaimedTeam ? playersDataset.filter(p => p.originalTeam === reclaimedTeam.franchiseId) : [];

      socket.emit('session_restored', {
        role: userRole,
        playerId: member.playerId,
        team: reclaimedTeam,
        roomState: sanitizeRoomState(room)
      });

      if (typeof callback === 'function') {
        callback({
          success: true,
          reclaimed: !!reclaimedTeam,
          role: userRole,
          playerId: member.playerId,
          sessionToken: token,
          roomState: sanitizeRoomState(room),
          team: reclaimedTeam,
          franchiseRoster
        });
      }

      broadcastRoomUpdate(code);
    } catch (err) {
      if (typeof callback === 'function') callback({ success: false, error: err.message });
    }
  };

  socket.on('reconnect_player', handleReconnect);
  socket.on('reconnect_session', handleReconnect);

  // 3. Select Team Franchise (Keyed strictly by franchiseId)
  socket.on('select_team', (data, callback) => {
    try {
      const { franchiseId, managerName, sessionToken } = data || {};
      const roomCode = sanitizeRoomCode((data && (data.roomCode || data.roomId)) || socket.roomCode);
      const room = getRoom(roomCode);
      if (!room) return callback && callback({ success: false, error: 'Room not found' });

      const member = getVerifiedMember(room, socket, sessionToken);
      if (!member) {
        return callback && callback({ success: false, error: 'Invalid or missing session token. Please reconnect.' });
      }

      // Match-Lock Guard: Once match is started, team selection is strictly locked
      if (room.isStarted || room.phase !== 'LOBBY' || room.status !== 'LOBBY') {
        return callback && callback({ success: false, error: 'Match already started. Franchise selection is locked.' });
      }

      // 10-Franchise Cap Guard
      const currentTeamCount = Object.keys(room.teams || {}).length;
      if (currentTeamCount >= 10 && (!member.teamId || !room.teams[member.teamId])) {
        return callback && callback({ success: false, error: 'Lobby is full! Max 10 franchises already claimed.' });
      }

      const franchise = IPL_TEAMS.find(t => t.id === franchiseId);
      if (!franchise) return callback && callback({ success: false, error: 'Invalid franchise selected.' });

      // Verify franchise availability (ensure not owned by another player)
      if (room.teams[franchise.id] && room.teams[franchise.id].ownerPlayerId !== member.playerId) {
        return callback && callback({ success: false, error: `${franchise.name} has already been claimed by another player!` });
      }

      // If user had previously selected a different team, release the old one
      if (member.teamId && member.teamId !== franchise.id && room.teams[member.teamId] && room.teams[member.teamId].ownerPlayerId === member.playerId) {
        delete room.teams[member.teamId];
      }

      const existing = room.teams[franchise.id];
      const mName = sanitizeName(managerName || member.playerName || (existing ? existing.managerName : 'Manager'), 'Manager');
      member.playerName = mName;
      member.teamId = franchise.id;
      member.role = 'manager';

      const teamData = {
        socketId: socket.id,
        sessionToken: member.sessionToken,
        ownerPlayerId: member.playerId,
        managerName: mName,
        franchiseId: franchise.id,
        name: franchise.name,
        color: franchise.color,
        textColor: franchise.textColor,
        logo: franchise.logo,
        icon: franchise.icon,
        purse: existing ? existing.purse : room.settings.initialPurse,
        squad: existing ? existing.squad : [],
        squadCount: existing ? existing.squad.length : 0,
        overseasCount: existing ? existing.overseasCount : 0,
        isHost: (room.hostPlayerId === member.playerId || socket.id === room.hostId),
        retentions: existing ? existing.retentions : [],
        isFolded: false
      };

      room.teams[franchise.id] = teamData;

      if (member.sessionToken && sessionRegistry.has(member.sessionToken)) {
        sessionRegistry.get(member.sessionToken).teamId = franchise.id;
        sessionRegistry.get(member.sessionToken).playerId = member.playerId;
        sessionRegistry.get(member.sessionToken).managerName = mName;
      }

      addRoomLog(room, `${teamData.managerName} took control of ${teamData.name} (${teamData.franchiseId})`);

      const franchiseRoster = playersDataset.filter(p => p.originalTeam === franchiseId);

      if (typeof callback === 'function') {
        callback({
          success: true,
          team: teamData,
          franchiseRoster
        });
      }
      broadcastRoomUpdate(roomCode);
    } catch (err) {
      if (typeof callback === 'function') callback({ success: false, error: err.message });
    }
  });

  // 4. Submit Retentions
  socket.on('submit_retentions', (data, callback) => {
    try {
      const { playerIds, sessionToken } = data || {};
      const roomCode = sanitizeRoomCode((data && (data.roomCode || data.roomId)) || socket.roomCode);
      const room = getRoom(roomCode);
      if (!room) return callback && callback({ success: false, error: 'Room not found' });

      const member = getVerifiedMember(room, socket, sessionToken);
      if (!member || !member.teamId || !room.teams[member.teamId]) {
        return callback && callback({ success: false, error: 'Select a team first.' });
      }

      const team = room.teams[member.teamId];
      if (team.ownerPlayerId !== member.playerId) {
        return callback && callback({ success: false, error: 'Unauthorized team mutation.' });
      }

      // Match-Lock Guard: Once match is started, retentions are locked
      if (room.isStarted || room.phase !== 'LOBBY' || room.status !== 'LOBBY') {
        return callback && callback({ success: false, error: 'Match already started. Retentions are locked.' });
      }

      if (!Array.isArray(playerIds)) {
        return callback && callback({ success: false, error: 'Invalid player selection format.' });
      }

      const retentionsAllowed = (room.settings && room.settings.retentionsAllowed !== undefined) ? room.settings.retentionsAllowed : 2;
      if (playerIds.length > retentionsAllowed) {
        return callback && callback({ success: false, error: `Maximum ${retentionsAllowed} retentions allowed by Room Host.` });
      }

      // Deduplication check (H5): No duplicate players allowed in the same squad
      if (new Set(playerIds).size !== playerIds.length) {
        return callback && callback({ success: false, error: 'Duplicate players cannot be retained in the same squad!' });
      }

      const maxOverseas = (room.settings && room.settings.maxOverseas) || 8;
      let totalCost = 0;
      const retainedSquad = [];
      let overseas = 0;

      for (let i = 0; i < playerIds.length; i++) {
        const pId = playerIds[i];
        const player = playersDataset.find(p => p.id === pId);
        if (!player) {
          return callback && callback({ success: false, error: `Player ID ${pId} not found in database.` });
        }

        // Franchise Alignment Check (H5, H6): Player must belong to this franchise
        if (player.originalTeam && player.originalTeam !== team.franchiseId) {
          return callback && callback({
            success: false,
            error: `Franchise violation: ${player.name} belongs to ${player.originalTeam}, not ${team.franchiseId}!`
          });
        }

        // Room-Wide Exclusivity Lock (H5): No two teams can retain the same player
        for (const [otherTeamId, otherTeam] of Object.entries(room.teams || {})) {
          if (otherTeamId !== team.franchiseId && Array.isArray(otherTeam.retentions) && otherTeam.retentions.includes(pId)) {
            return callback && callback({
              success: false,
              error: `Collision: ${player.name} has already been retained by ${otherTeam.name || otherTeamId}!`
            });
          }
        }

        if (player.isOverseas) {
          overseas += 1;
        }

        const cost = RETENTION_COSTS[i] || 100000000;
        totalCost += cost;

        retainedSquad.push({
          ...player,
          finalPrice: cost,
          acquiredVia: 'RETENTION'
        });
      }

      // Overseas Cap Check (H6)
      if (overseas > maxOverseas) {
        return callback && callback({
          success: false,
          error: `Overseas quota exceeded! Maximum allowed overseas players is ${maxOverseas}.`
        });
      }

      if (totalCost > room.settings.initialPurse) {
        return callback && callback({ success: false, error: 'Retention cost exceeds total purse!' });
      }

      team.purse = room.settings.initialPurse - totalCost;
      team.squad = retainedSquad;
      team.squadCount = retainedSquad.length;
      team.overseasCount = overseas;
      team.retentions = [...playerIds];

      addRoomLog(room, `${team.name} locked in ${playerIds.length} retention(s). Remaining purse: ₹${(team.purse / 10000000).toFixed(2)} Cr.`);

      if (typeof callback === 'function') callback({ success: true, team });
      broadcastRoomUpdate(roomCode);
    } catch (err) {
      if (typeof callback === 'function') callback({ success: false, error: err.message });
    }
  });

  // 5. Start Auction (Host)
  socket.on('start_auction', (data, callback) => {
    try {
      const { sessionToken } = data || {};
      const roomCode = sanitizeRoomCode((data && (data.roomCode || data.roomId)) || socket.roomCode);
      const room = getRoom(roomCode);
      if (!room) return callback && callback({ success: false, error: 'Room not found' });
      const member = getVerifiedMember(room, socket, sessionToken);
      const isHostCaller = (member && member.playerId === room.hostPlayerId) || socket.id === room.hostId;
      if (!isHostCaller) return callback && callback({ success: false, error: 'Host only' });

      // State Machine Guard (H1, C4): Auction can only be started from LOBBY phase
      if (room.phase !== 'LOBBY' || room.isStarted) {
        return callback && callback({ success: false, error: 'Auction can only be started from LOBBY phase.' });
      }

      const teamCount = Object.keys(room.teams || {}).length;
      if (teamCount === 0) {
        return callback && callback({ success: false, error: 'At least 1 team must join to start!' });
      }

      // Remove all retained players from auction pool
      const retainedPlayerIds = new Set();
      for (const t of Object.values(room.teams)) {
        (t.retentions || []).forEach(id => retainedPlayerIds.add(id));
      }

      room.playerPool = room.playerPool.filter(p => !retainedPlayerIds.has(p.id));

      if (room.playerPool.length === 0) {
        return callback && callback({ success: false, error: 'No players left in pool!' });
      }

      // Shuffle player pool so every match has a completely randomized, unique player order
      shuffleArray(room.playerPool);

      room.isStarted = true;
      room.status = 'AUCTION';
      room.phase = 'BIDDING';
      room.lotVersion = 1;
      room.auctionIndex = -1;

      addRoomLog(room, `🚀 Host started the Mega Auction with ${room.playerPool.length} available players!`, 'announcement');
      advanceToNextPlayer(room);

      if (typeof callback === 'function') callback({ success: true });
    } catch (err) {
      if (typeof callback === 'function') callback({ success: false, error: err.message });
    }
  });

  // 5B. Controlled Host Wrap-Up (Accelerated Phase / Manual Finalize)
  socket.on('host_conclude_auction', (data, callback) => {
    try {
      const { sessionToken } = data || {};
      const roomCode = sanitizeRoomCode((data && (data.roomCode || data.roomId)) || socket.roomCode);
      const room = getRoom(roomCode);
      if (!room) return callback && callback({ success: false, error: 'Room not found' });
      const member = getVerifiedMember(room, socket, sessionToken);
      const isHostCaller = (member && member.playerId === room.hostPlayerId) || socket.id === room.hostId;
      if (!isHostCaller) return callback && callback({ success: false, error: 'Host only' });
      if (room.status !== 'AUCTION') return callback && callback({ success: false, error: 'Auction is not currently in progress' });

      if (!canConcludeEarly(room)) {
        const minRequired = (room.settings && room.settings.minSquadSize) || 15;
        return callback && callback({
          success: false,
          error: `All franchises must have at least ${minRequired} players before closing early.`
        });
      }

      // H10: If active bidding is occurring, resolve the active lot before concluding
      if (room.currentPlayer) {
        RoomTimerManager.clear(room);
        const player = room.currentPlayer;
        if (room.highestBidder) {
          const winningTeam = room.teams[room.highestBidder.teamId];
          if (winningTeam) {
            winningTeam.purse -= room.currentBid;
            winningTeam.squad.push({
              ...player,
              finalPrice: room.currentBid,
              acquiredVia: 'AUCTION'
            });
            if (player.isOverseas) {
              winningTeam.overseasCount = (winningTeam.overseasCount || 0) + 1;
            }
            winningTeam.squadCount = winningTeam.squad.length;

            addRoomLog(
              room,
              `🔨 SOLD! ${player.name} sold to ${winningTeam.name} (${winningTeam.franchiseId}) for ₹${(room.currentBid / 10000000).toFixed(2)} Cr upon match conclusion!`,
              'sold',
              { playerName: player.name, teamName: winningTeam.name, teamId: winningTeam.franchiseId, price: room.currentBid, rating: player.rating }
            );

            io.to(room.code).emit('player_sold', {
              player,
              team: winningTeam,
              price: room.currentBid
            });
          }
        } else {
          room.unsoldPlayers.push(player);
          addRoomLog(room, `❌ UNSOLD! ${player.name} went unsold as auction concluded.`, 'unsold');
          io.to(room.code).emit('player_unsold', { player });
        }
        room.currentPlayer = null;
        room.highestBidder = null;
      }

      triggerAuctionEndSequence(room, 'Host concluded auction & finalized squads.');
      if (typeof callback === 'function') callback({ success: true });
    } catch (err) {
      if (typeof callback === 'function') callback({ success: false, error: err.message });
    }
  });

  // 6. Place Bid (Synchronous Atomic Handling + Fold Lock Guard + Monotonic Lot Version)
  socket.on('place_bid', (data, callback) => {
    try {
      const { expectedCurrentBid, lotVersion, sessionToken } = data || {};
      const roomCode = sanitizeRoomCode((data && (data.roomCode || data.roomId)) || socket.roomCode);
      const room = getRoom(roomCode);
      if (!room) return callback && callback({ success: false, error: 'Room not found' });

      // State Machine Guard (C4, H1, H2, H4): Strictly allow bids ONLY in BIDDING phase
      if (room.phase !== 'BIDDING' || room.status !== 'AUCTION' || !room.currentPlayer) {
        return callback && callback({ 
          success: false, 
          error: room.phase === 'HAMMER' ? 'Hammer is falling! Bidding closed for this player.' : 'No active player on hammer.' 
        });
      }

      const member = getVerifiedMember(room, socket, sessionToken);
      const team = getTeamForSocket(room, socket, sessionToken);
      if (!team) return callback && callback({ success: false, error: 'You have not claimed a team franchise.' });

      // Strictly verify franchise ownership
      if (member && team.ownerPlayerId !== member.playerId) {
        return callback && callback({ success: false, error: 'Unauthorized team action.' });
      }

      // STRICT CHECK: Block folded teams from placing any bids on this player
      room.currentLot = room.currentLot || {
        ...room.currentPlayer,
        player: room.currentPlayer,
        currentBid: room.currentBid,
        basePrice: room.currentPlayer ? room.currentPlayer.basePrice : 10000000,
        highestBidderTeamId: null,
        hasOpeningBid: false,
        lotVersion: room.lotVersion || 1,
        foldedTeamIds: []
      };
      room.currentLot.foldedTeamIds = room.currentLot.foldedTeamIds || [];
      if (room.currentLot.foldedTeamIds.includes(team.franchiseId) || room.teams[team.franchiseId]?.isFolded) {
        socket.emit('error_toast', 'You have folded for this player and cannot bid.');
        return callback && callback({ success: false, error: 'You have folded for this player and cannot bid.' });
      }

      // Guard: Highest bidder cannot bid against themselves (allow self-raise in solo/1-team test mode)
      const isSoloTesting = Object.keys(room.teams || {}).length <= 1;
      if (!isSoloTesting && room.highestBidder && (room.highestBidder.socketId === socket.id || room.highestBidder.teamId === team.franchiseId || (member && room.highestBidder.playerId === member.playerId))) {
        return callback && callback({ success: false, error: 'You already hold the highest bid!' });
      }

      // Check max squad size
      if ((team.squad ? team.squad.length : 0) >= room.settings.maxSquadSize) {
        return callback && callback({ success: false, error: `Squad capacity full (${room.settings.maxSquadSize} max)!` });
      }

      // Check overseas limit
      if (room.currentPlayer.isOverseas && (team.overseasCount || 0) >= room.settings.maxOverseas) {
        return callback && callback({ success: false, error: `Overseas player limit reached (${room.settings.maxOverseas} max)!` });
      }

      // H3: Monotonic lotVersion check for opening/fast bid race conditions
      if (lotVersion !== undefined && lotVersion !== null) {
        if (Number(lotVersion) !== (room.lotVersion || 1)) {
          return callback && callback({
            success: false,
            error: 'Price just changed! Please review the new bid.',
            currentBid: room.currentBid,
            lotVersion: room.lotVersion || 1
          });
        }
      }

      // Calculate next bid amount
      let nextBidAmount;
      if (!room.highestBidder) {
        nextBidAmount = room.currentPlayer.basePrice;
      } else {
        const inc = calculateIncrement(room.currentBid);
        nextBidAmount = room.currentBid + inc;
      }

      // Outbid collision check
      if (expectedCurrentBid !== undefined && expectedCurrentBid !== null) {
        if (room.highestBidder && expectedCurrentBid < room.currentBid) {
          return callback && callback({ 
            success: false, 
            error: `Outbid! Price is now ₹${(room.currentBid / 10000000).toFixed(2)} Cr.`,
            currentBid: room.currentBid,
            serverCurrentBid: room.currentBid,
            lotVersion: room.lotVersion || 1,
            nextExpectedBid: nextBidAmount
          });
        }
      }

      // Purse balance validation
      if (team.purse < nextBidAmount) {
        return callback && callback({ 
          success: false, 
          error: `Insufficient purse! Needed: ₹${(nextBidAmount / 10000000).toFixed(2)} Cr, Available: ₹${(team.purse / 10000000).toFixed(2)} Cr.` 
        });
      }

      // Atomic state update
      room.openingBidPlaced = true;
      room.currentBid = nextBidAmount;
      room.lotVersion = (room.lotVersion || 1) + 1;
      room.highestBidder = {
        socketId: socket.id,
        playerId: team.ownerPlayerId || (member ? member.playerId : socket.playerId) || null,
        teamId: team.franchiseId,
        teamName: team.name,
        managerName: team.managerName,
        logo: team.logo,
        color: team.color
      };

      // Accept bid, update leader, increment sequence
      room.currentLot.hasOpeningBid = true;
      room.currentLot.highestBidderTeamId = team.franchiseId;
      room.currentLot.highestBidder = room.highestBidder;
      room.currentLot.currentBid = nextBidAmount;
      room.currentLot.lotVersion = room.lotVersion;

      // CRITICAL: DO NOT clear room.currentLot.foldedTeamIds here!
      // Teams that folded remain folded for this player.

      addRoomLog(
        room,
        `💰 ${team.name} (${team.franchiseId}) raised bid to ₹${(nextBidAmount / 10000000).toFixed(2)} Cr!`,
        'bid',
        { teamName: team.name, teamId: team.franchiseId, bid: nextBidAmount }
      );

      // Reset countdown to 15 seconds
      startCountdown(room);

      io.to(room.code).emit('bid_accepted', {
        lot: room.currentLot,
        currentBid: room.currentBid,
        highestBidder: room.highestBidder,
        highestBidderTeamId: team.franchiseId,
        lotVersion: room.currentLot.lotVersion,
        nextIncrement: calculateIncrement(room.currentBid),
        foldedTeams: room.currentLot.foldedTeamIds,
        foldedTeamIds: room.currentLot.foldedTeamIds
      });

      // Check consensus hammer resolution after bid
      evaluateFoldConsensus(room);
      broadcastRoomUpdate(room.code);

      if (typeof callback === 'function') {
        callback({ success: true, currentBid: room.currentBid, lotVersion: room.lotVersion });
      }
    } catch (err) {
      if (typeof callback === 'function') callback({ success: false, error: err.message });
    }
  });

  // 7. Host Skip Player (Strictly in BIDDING phase)
  socket.on('skip_player', (data, callback) => {
    try {
      const { sessionToken } = data || {};
      const roomCode = sanitizeRoomCode((data && (data.roomCode || data.roomId)) || socket.roomCode);
      const room = getRoom(roomCode);
      if (!room) return callback && callback({ success: false, error: 'Room not found' });
      const member = getVerifiedMember(room, socket, sessionToken);
      const isHostCaller = (member && member.playerId === room.hostPlayerId) || socket.id === room.hostId;
      if (!isHostCaller) return callback && callback({ success: false, error: 'Host only' });

      // State Machine Guard: Skip player only allowed during BIDDING phase
      if (room.phase !== 'BIDDING' || room.status !== 'AUCTION' || !room.currentPlayer) {
        return callback && callback({ success: false, error: 'Cannot skip player outside active BIDDING phase.' });
      }

      RoomTimerManager.clear(room);

      // Save to skip history stack for undo
      room.skipHistory.push({
        player: room.currentPlayer,
        auctionIndex: room.auctionIndex
      });

      addRoomLog(room, `⏩ Host skipped ${room.currentPlayer.name}. Pushed to end of pool.`, 'warning');

      room.playerPool.push(room.currentPlayer);
      advanceToNextPlayer(room);

      if (typeof callback === 'function') callback({ success: true });
    } catch (err) {
      if (typeof callback === 'function') callback({ success: false, error: err.message });
    }
  });

  // 8. Host Undo Skip
  socket.on('undo_skip_player', (data, callback) => {
    try {
      const { sessionToken } = data || {};
      const roomCode = sanitizeRoomCode((data && (data.roomCode || data.roomId)) || socket.roomCode);
      const room = getRoom(roomCode);
      if (!room) return callback && callback({ success: false, error: 'Room not found' });
      const member = getVerifiedMember(room, socket, sessionToken);
      const isHostCaller = (member && member.playerId === room.hostPlayerId) || socket.id === room.hostId;
      if (!isHostCaller) return callback && callback({ success: false, error: 'Host only' });

      // State Machine Guard (H2): Block undo if auction is concluding or concluded
      if (room.phase === 'CONCLUDED' || room.isConcluding) {
        return callback && callback({ success: false, error: 'Cannot undo skip after auction is concluded.' });
      }
      if (room.phase === 'HAMMER') {
        return callback && callback({ success: false, error: 'Cannot undo skip during hammer resolution.' });
      }

      if (room.skipHistory.length === 0) {
        return callback && callback({ success: false, error: 'No skipped player to undo.' });
      }

      RoomTimerManager.clear(room);

      const lastSkipped = room.skipHistory.pop();
      room.playerPool.pop(); // Remove the duplicated entry pushed to the end

      // Rewind room.auctionIndex to properly restore position in pool
      room.auctionIndex = lastSkipped.auctionIndex;
      room.phase = 'BIDDING';
      room.lotVersion = (room.lotVersion || 1) + 1;
      room.currentPlayer = lastSkipped.player;
      room.currentBid = lastSkipped.player.basePrice;
      room.highestBidder = null;
      room.openingBidPlaced = false;
      room.timerSeconds = 15;
      room.isTimerRunning = false;
      room.foldedTeams = [];
      room.currentLot = {
        ...lastSkipped.player,
        player: lastSkipped.player,
        currentBid: lastSkipped.player.basePrice,
        basePrice: lastSkipped.player.basePrice,
        highestBidderTeamId: null,
        highestBidder: null,
        hasOpeningBid: false,
        lotVersion: room.lotVersion,
        foldedTeamIds: []
      };
      if (room.teams) {
        for (const t of Object.values(room.teams)) {
          t.isFolded = false;
        }
      }
      startCountdown(room);

      addRoomLog(room, `⏪ Host restored skipped star: ${lastSkipped.player.name}!`, 'announcement');
      broadcastRoomUpdate(roomCode);

      if (typeof callback === 'function') callback({ success: true, player: lastSkipped.player });
    } catch (err) {
      if (typeof callback === 'function') callback({ success: false, error: err.message });
    }
  });

  // 9. Team FOLD / Pass (Persistent per-lot fold + evaluateFoldConsensus)
  socket.on('team_fold', (data, callback) => {
    try {
      const { sessionToken } = data || {};
      const roomCode = sanitizeRoomCode((data && (data.roomCode || data.roomId)) || socket.roomCode);
      const room = getRoom(roomCode);
      if (!room) return callback && callback({ success: false, error: 'Room not found' });

      // State Machine Guard (C4, H1, H4): Folds strictly allowed ONLY during BIDDING phase
      if (room.phase !== 'BIDDING' || room.status !== 'AUCTION' || !room.currentPlayer) {
        return callback && callback({ 
          success: false, 
          error: room.phase === 'HAMMER' ? 'Hammer is falling! Lot is resolving.' : 'No active player on hammer' 
        });
      }

      const member = getVerifiedMember(room, socket, sessionToken);
      const team = getTeamForSocket(room, socket, sessionToken);
      if (!team) return callback && callback({ success: false, error: 'Select a team first' });

      if (member && team.ownerPlayerId !== member.playerId) {
        return callback && callback({ success: false, error: 'Unauthorized team action.' });
      }

      const teamId = team.franchiseId;
      if (!room.currentLot) {
        room.currentLot = {
          ...room.currentPlayer,
          player: room.currentPlayer,
          currentBid: room.currentBid,
          basePrice: room.currentPlayer ? room.currentPlayer.basePrice : 10000000,
          highestBidderTeamId: room.highestBidder ? room.highestBidder.teamId : null,
          highestBidder: room.highestBidder,
          hasOpeningBid: Boolean(room.highestBidder),
          lotVersion: room.lotVersion || 1,
          foldedTeamIds: []
        };
      }

      // Rule A: Highest bidder CANNOT fold against their own active bid
      if (room.currentLot.hasOpeningBid && room.currentLot.highestBidderTeamId === teamId) {
        socket.emit('error_toast', 'You hold the highest bid and cannot fold.');
        return callback && callback({ success: false, error: 'You are the highest bidder! Leading team cannot fold.' });
      }

      // Rule B: Add to lot folds array if not already present
      room.currentLot.foldedTeamIds = room.currentLot.foldedTeamIds || [];
      if (!room.currentLot.foldedTeamIds.includes(teamId)) {
        room.currentLot.foldedTeamIds.push(teamId);
      }
      if (!room.foldedTeams) room.foldedTeams = [];
      if (!Array.isArray(room.foldedTeams)) room.foldedTeams = [];
      if (!room.foldedTeams.includes(teamId)) {
        room.foldedTeams.push(teamId);
      }

      // Rule C: Set isFolded on the team object
      if (room.teams[teamId]) {
        room.teams[teamId].isFolded = true;
      }

      addRoomLog(
        room,
        `✋ ${team.name} (${teamId}) folded on ${room.currentPlayer.name}.`,
        'info'
      );

      // Broadcast fold state to everyone
      io.to(room.code).emit('team_folded', {
        teamId,
        foldedTeamIds: room.currentLot.foldedTeamIds,
        foldedCount: room.currentLot.foldedTeamIds.length,
        totalEligible: Object.keys(room.teams || {}).length
      });

      broadcastRoomUpdate(roomCode);

      if (typeof callback === 'function') {
        callback({
          success: true,
          folded: true,
          foldedTeamIds: room.currentLot.foldedTeamIds
        });
      }

      // Evaluate instant hammer consensus
      evaluateFoldConsensus(room);
    } catch (err) {
      if (typeof callback === 'function') callback({ success: false, error: err.message });
    }
  });

  // 9B. Switch User Role (Manager <-> Spectator runtime switch)
  socket.on('switch_role', (data, callback) => {
    try {
      const { role } = data || {};
      const roomCode = sanitizeRoomCode((data && (data.roomCode || data.roomId)) || socket.roomCode);
      const room = getRoom(roomCode);
      if (!room) return callback && callback({ success: false, error: 'Room not found' });
      const targetRole = role === 'spectator' ? 'spectator' : 'manager';
      const member = socket.playerId ? (typeof room.members.get === 'function' ? room.members.get(socket.playerId) : room.members[socket.playerId]) : null;
      if (member) member.role = targetRole;

      if (targetRole === 'spectator') {
        if (!room.spectators) room.spectators = new Map();
        const specData = {
          socketId: socket.id,
          playerId: socket.playerId,
          managerName: member ? member.playerName : 'Spectator',
          supportedTeam: null
        };
        if (typeof room.spectators.set === 'function') room.spectators.set(socket.id, specData);
        if (typeof room.spectators === 'object') room.spectators[socket.id] = specData;
        addRoomLog(room, `👀 ${member ? member.playerName : 'Player'} switched to Spectator View.`);
      } else {
        if (room.spectators) {
          if (typeof room.spectators.delete === 'function') room.spectators.delete(socket.id);
          delete room.spectators[socket.id];
        }
        addRoomLog(room, `🔨 ${member ? member.playerName : 'Player'} switched to Manager View.`);
      }
      broadcastRoomUpdate(roomCode);
      if (typeof callback === 'function') callback({ success: true, role: targetRole });
    } catch (err) {
      if (typeof callback === 'function') callback({ success: false, error: err.message });
    }
  });

  // 9C. Host Kick Participant
  socket.on('kick_participant', (data, callback) => {
    try {
      const { targetPlayerId, targetSocketId } = data || {};
      const roomCode = sanitizeRoomCode((data && (data.roomCode || data.roomId)) || socket.roomCode);
      const room = getRoom(roomCode);
      if (!room) return callback && callback({ success: false, error: 'Room not found' });

      const isHostCaller = (socket.id === room.hostId || (socket.playerId && socket.playerId === room.hostPlayerId));
      if (!isHostCaller) return callback && callback({ success: false, error: 'Host only action' });

      // Find target member
      if (!room.members) room.members = new Map();
      let targetMember = null;
      if (targetPlayerId && room.members.has(targetPlayerId)) {
        targetMember = room.members.get(targetPlayerId);
      } else if (targetSocketId) {
        targetMember = Array.from(room.members.values()).find(m => m.socketId === targetSocketId);
      }

      if (!targetMember) {
        return callback && callback({ success: false, error: 'Participant not found in room.' });
      }

      // Host cannot kick themselves
      if (targetMember.playerId === room.hostPlayerId || targetMember.socketId === room.hostId) {
        return callback && callback({ success: false, error: 'Host cannot be kicked.' });
      }

      const kickedSocketId = targetMember.socketId;
      const kickedPlayerId = targetMember.playerId;
      const kickedTeamId = targetMember.teamId;
      const kickedName = targetMember.playerName;

      // Notify target client
      if (kickedSocketId) {
        io.to(kickedSocketId).emit('kicked_from_room', {
          roomCode,
          reason: 'You were removed from the room by the host.'
        });
        const kickedSocket = io.sockets.sockets.get(kickedSocketId);
        if (kickedSocket) {
          kickedSocket.leave(roomCode);
          kickedSocket.roomCode = null;
        }
      }

      // Remove from room.members
      room.members.delete(kickedPlayerId);

      // Handle team detachment
      if (kickedTeamId && room.teams[kickedTeamId]) {
        if (!room.isStarted || room.phase === 'LOBBY') {
          // Pre-auction: free up the franchise seat for another user
          delete room.teams[kickedTeamId];
        } else {
          // In-auction: mark auto-folded so match doesn't stall
          if (!room.foldedTeams) room.foldedTeams = [];
          if (!Array.isArray(room.foldedTeams)) room.foldedTeams = [];
          if (!room.foldedTeams.includes(kickedTeamId)) room.foldedTeams.push(kickedTeamId);
          if (room.currentLot) {
            room.currentLot.foldedTeamIds = room.currentLot.foldedTeamIds || [];
            if (!room.currentLot.foldedTeamIds.includes(kickedTeamId)) room.currentLot.foldedTeamIds.push(kickedTeamId);
          }
          room.teams[kickedTeamId].isFolded = true;
          evaluateFoldConsensus(room);
        }
      }

      if (room.spectators && kickedSocketId) {
        room.spectators.delete(kickedSocketId);
      }

      addRoomLog(room, `🚫 ${kickedName} was kicked from the room by Host.`, 'warning');
      broadcastRoomUpdate(roomCode);

      if (typeof callback === 'function') callback({ success: true, kickedPlayerId });
    } catch (err) {
      if (typeof callback === 'function') callback({ success: false, error: err.message });
    }
  });

  // 9D. Leave Room
  socket.on('leave_room', (data, callback) => {
    try {
      const { roomCode, playerId, sessionToken } = data || {};
      const code = sanitizeRoomCode(roomCode || (data && data.roomId) || socket.roomCode || '');
      const room = getRoom(code);
      if (!room) {
        if (typeof callback === 'function') callback({ success: false, error: 'Room not found' });
        return;
      }

      const member = getVerifiedMember(room, socket, sessionToken) || (socket.playerId && room.members ? (typeof room.members.get === 'function' ? room.members.get(socket.playerId) : room.members[socket.playerId]) : null);
      const pId = member ? member.playerId : (playerId || socket.playerId);

      if (member) {
        const teamId = member.teamId;
        // If auction hasn't started, release their franchise
        if (!room.isStarted && teamId && room.teams && room.teams[teamId]) {
          if (room.teams[teamId].ownerPlayerId === member.playerId) {
            delete room.teams[teamId];
          }
        } else if (room.isStarted && teamId && room.teams && room.teams[teamId]) {
          // If auction is live, mark folded so match does not stall
          if (!room.foldedTeams) room.foldedTeams = [];
          if (!Array.isArray(room.foldedTeams)) room.foldedTeams = [];
          if (!room.foldedTeams.includes(teamId)) room.foldedTeams.push(teamId);
          if (room.currentLot) {
            room.currentLot.foldedTeamIds = room.currentLot.foldedTeamIds || [];
            if (!room.currentLot.foldedTeamIds.includes(teamId)) room.currentLot.foldedTeamIds.push(teamId);
          }
          room.teams[teamId].isFolded = true;
          evaluateFoldConsensus(room);
        }

        if (member.disconnectTimeout) {
          clearTimeout(member.disconnectTimeout);
          member.disconnectTimeout = null;
        }

        if (room.members) {
          if (typeof room.members.delete === 'function') {
            room.members.delete(pId);
          }
          delete room.members[pId];
        }
      }

      if (room.spectators) {
        if (typeof room.spectators.delete === 'function') room.spectators.delete(socket.id);
        delete room.spectators[socket.id];
      }

      socket.leave(code);
      if (socket.roomCode === code) socket.roomCode = null;

      addRoomLog(room, `🚪 ${member ? member.playerName : 'A participant'} left the match.`, 'info');

      // Re-assign host if host left
      if (socket.id === room.hostId || (pId && pId === room.hostPlayerId)) {
        const remainingSockets = Array.from(io.sockets.adapter.rooms.get(code) || []).filter(s => s !== socket.id);
        if (remainingSockets.length > 0) {
          room.hostId = remainingSockets[0];
          const newHostSocket = io.sockets.sockets.get(remainingSockets[0]);
          if (newHostSocket && newHostSocket.playerId) {
            room.hostPlayerId = newHostSocket.playerId;
          }
          addRoomLog(room, `👑 Host left. Transferred host privileges.`, 'info');
        }
      }

      const memberCount = room.members instanceof Map ? room.members.size : Object.keys(room.members || {}).length;
      const teamsData = Object.values(room.teams || {});

      // Broadcast updated room state & player_left event to remaining participants
      io.to(code).emit('player_left', {
        playerId: pId,
        teams: teamsData,
        memberCount
      });

      broadcastRoomUpdate(code);

      if (typeof callback === 'function') callback({ success: true });
    } catch (err) {
      console.error('[leave_room] error:', err);
      if (typeof callback === 'function') callback({ success: false, error: err.message });
    }
  });

  // 10. Disconnect (3-Minute Grace Period Engine)
  socket.on('disconnect', () => {
    const roomCode = sanitizeRoomCode(socket.roomCode);
    if (!roomCode) return;
    const room = getRoom(roomCode);
    if (!room) return;

    const pId = socket.playerId;
    if (room.members && pId && room.members.has(pId)) {
      const member = room.members.get(pId);
      member.isOnline = false;

      // 3-Minute Grace Period on Disconnect: do not drop franchise or reset roster
      if (member.disconnectTimeout) clearTimeout(member.disconnectTimeout);
      member.disconnectTimeout = setTimeout(() => {
        if (!member.isOnline) {
          // Grace period expired without reconnection
          if (!room.isStarted && member.teamId && room.teams && room.teams[member.teamId]) {
            if (room.teams[member.teamId].ownerPlayerId === member.playerId) {
              delete room.teams[member.teamId];
            }
          }
          addRoomLog(room, `⏳ Disconnect grace period expired for ${member.playerName}.`, 'info');
          broadcastRoomUpdate(roomCode);
        }
      }, 3 * 60 * 1000); // 3 minutes
    }

    if (room.spectators && room.spectators.has(socket.id)) {
      room.spectators.delete(socket.id);
    }

    const leavingTeam = getTeamForSocket(room, socket);
    if (leavingTeam) {
      addRoomLog(room, `⚠️ ${leavingTeam.managerName} (${leavingTeam.franchiseId}) disconnected (reconnection window active).`);
    }

    // Host transfer if needed
    if (socket.id === room.hostId) {
      const activeSockets = Array.from(io.sockets.adapter.rooms.get(roomCode) || []).filter(s => s !== socket.id);
      if (activeSockets.length > 0) {
        room.hostId = activeSockets[0];
        const newHostSocket = io.sockets.sockets.get(activeSockets[0]);
        if (newHostSocket && newHostSocket.playerId) {
          room.hostPlayerId = newHostSocket.playerId;
        }
        addRoomLog(room, `👑 Host disconnected. New host assigned.`);
      } else {
        // Cache grace period: keep room alive for 5 minutes in memory if all disconnected
        if (!room.cleanupTimer) {
          room.cleanupTimer = setTimeout(() => {
            const currentSockets = Array.from(io.sockets.adapter.rooms.get(roomCode) || []);
            if (currentSockets.length === 0) {
              RoomTimerManager.clear(room);
              deleteRoom(roomCode);
              console.log(`[CLEANUP] Room ${roomCode} wiped from memory after 5 min idle.`);
            }
          }, 5 * 60 * 1000);
        }
      }
    }

    broadcastRoomUpdate(roomCode);
  });

  // 10B. Spectator Cheer & Decibel Engine (Targeted Delivery - H8)
  socket.on('spectator_cheer', ({ teamId, cheerType, cheerEmoji, roomCode: clientRoomCode }) => {
    try {
      const roomCode = sanitizeRoomCode(socket.roomCode || clientRoomCode);
      if (!roomCode) return;
      const room = getRoom(roomCode);
      if (!room) return;

      // Update decibel meter for all participants
      if (!room.decibelMeter) {
        room.decibelMeter = {};
        IPL_TEAMS.forEach(t => { room.decibelMeter[t.id] = 50; });
      }

      const tId = (teamId || '').toUpperCase();
      let currentDecibel = 50;
      if (tId && room.decibelMeter[tId] !== undefined) {
        room.decibelMeter[tId] = Math.min(100, (room.decibelMeter[tId] || 50) + 6);
        currentDecibel = room.decibelMeter[tId];
      }

      // Broadcast global decibel update (H8 unified contract + backward compatibility)
      io.to(roomCode).emit('update_decibel_meter', {
        decibelMeter: room.decibelMeter,
        teamId: tId,
        currentDecibel
      });
      io.to(roomCode).emit('decibel_update', {
        decibelMeter: room.decibelMeter,
        cheeredTeam: tId,
        cheerType: cheerType || 'cheer',
        currentDecibel
      });

      // Target delivery: send floating particles only to the cheering spectator and the cheered franchise manager
      const cheerPayload = {
        teamId: tId,
        cheerType: cheerType || 'cheer',
        cheerEmoji: cheerEmoji || '👏',
        currentDecibel,
        fromSpectator: socket.id
      };

      // 1. Emit to cheering spectator (both event names for seamless contract matching)
      socket.emit('spectator_cheer_effect', cheerPayload);
      socket.emit('team_cheered', cheerPayload);

      // 2. Locate franchise manager socket and emit targeted cheer
      if (tId && room.teams) {
        for (const team of Object.values(room.teams)) {
          if (team.franchiseId === tId && team.socketId && team.socketId !== socket.id) {
            io.to(team.socketId).emit('spectator_cheer_effect', cheerPayload);
            io.to(team.socketId).emit('team_cheered', cheerPayload);
            break;
          }
        }
      }
    } catch (err) {
      console.error('[CHEER ERROR]', err.message);
    }
  });

  // 11. Leave Match (Explicit Cleanup)
  socket.on('leave_match', (data, callback) => {
    try {
      const { sessionToken } = data || {};
      const roomCode = sanitizeRoomCode((data && (data.roomCode || data.roomId)) || socket.roomCode);
      if (sessionToken && sessionRegistry.has(sessionToken)) {
        sessionRegistry.delete(sessionToken);
      }
      if (roomCode) {
        const room = getRoom(roomCode);
        if (room && room.spectators) {
          if (typeof room.spectators.delete === 'function') room.spectators.delete(socket.id);
          delete room.spectators[socket.id];
        }
        socket.leave(roomCode);
        socket.roomCode = null;
      }
      if (typeof callback === 'function') callback({ success: true });
    } catch (err) {
      if (typeof callback === 'function') callback({ success: false, error: err.message });
    }
  });
});

// Periodic Decibel Meter Ambient Decay (Towards 50 base)
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.decibelMeter) {
      let changed = false;
      for (const tId in room.decibelMeter) {
        if (room.decibelMeter[tId] > 50) {
          room.decibelMeter[tId] = Math.max(50, room.decibelMeter[tId] - 2);
          changed = true;
        }
      }
      if (changed && room.code) {
        io.to(room.code).emit('decibel_decay', { decibelMeter: room.decibelMeter });
      }
    }
  }
}, 2000);

// REST Health API
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    activeRooms: rooms.size,
    totalPlayersLoaded: playersDataset.length,
    timestamp: new Date().toISOString()
  });
});

// REST Franchise Players API for retention picker
app.get('/api/franchise-players/:teamId', (req, res) => {
  const teamId = req.params.teamId.toUpperCase();
  const players = playersDataset.filter(p => p.originalTeam === teamId);
  res.json(players);
});

// Safe root / SPA fallback
app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }
  res.json({
    status: 'ok',
    service: 'IPL Auction Live Backend Server',
    message: 'Backend is active and ready for Socket.IO connections.',
    activeRooms: rooms.size,
    totalPlayersLoaded: playersDataset.length,
    timestamp: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🏏 IPL AUCTION SERVER RUNNING ON PORT ${PORT}`);
});
