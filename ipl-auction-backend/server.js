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

function generateSessionToken() {
  return crypto.randomBytes(16).toString('hex');
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
  } while (rooms.has(code));
  return code;
}

// Retention cost slabs
const RETENTION_COSTS = [180000000, 140000000, 110000000, 180000000, 140000000];

// Controlled host wrap-up threshold check
function canConcludeEarly(room) {
  if (room.status !== 'AUCTION') return false;
  if (!room.teams || room.teams.size === 0) return false;
  const minRequired = (room.settings && room.settings.minSquadSize) || 15;
  for (const team of room.teams.values()) {
    if ((team.squad ? team.squad.length : 0) < minRequired) {
      return false;
    }
  }
  return true;
}

// Victory scoring formula: Team Total Points = sum of roster player ratings
function calculateStandings(room) {
  const teams = Array.from(room.teams.values());
  const scoredTeams = teams.map(t => {
    const totalPoints = t.squad.reduce((sum, p) => sum + (p.rating || 75), 0);
    const avgRating = t.squad.length > 0 ? (totalPoints / t.squad.length).toFixed(1) : '0.0';
    return {
      ...t,
      teamId: t.franchiseId,
      teamName: t.name,
      remainingPurse: t.purse,
      logo: t.logo || `/logos/${t.franchiseId}.svg`,
      color: t.color || '#334155',
      totalPoints,
      avgRating: Number(avgRating),
      squadCount: t.squad.length
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
  clearRoomTimer(room);

  addRoomLog(room, `🏁 ${reason || 'Auction concluded!'} Tallying final squad points...`, 'finish');
  io.to(room.code).emit('auction_concluding', {
    reason: reason || 'Auction concluded',
    countdown: 5
  });

  setTimeout(() => {
    room.status = 'FINISHED';
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
  if (!room.teams || room.teams.size === 0) return false;
  const maxSquad = (room.settings && room.settings.maxSquadSize) || 25;
  
  let minBasePrice = 20000000;
  for (let i = room.auctionIndex + 1; i < room.playerPool.length; i++) {
    if (room.playerPool[i].basePrice < minBasePrice) {
      minBasePrice = room.playerPool[i].basePrice;
    }
  }

  for (const team of room.teams.values()) {
    const hasSlot = team.squad.length < maxSquad;
    const hasPurse = team.purse >= minBasePrice;
    if (hasSlot && hasPurse) {
      return false; // at least one team has slots and funds left
    }
  }
  return true;
}

function sanitizeRoomState(room) {
  const foldedList = Array.from(room.foldedTeams || []);
  const requiredFolds = room.highestBidder ? Math.max(room.teams.size - 1, 1) : Math.max(room.teams.size, 1);
  return {
    code: room.code,
    hostId: room.hostId,
    status: room.status,
    isStarted: !!room.isStarted,
    isConcluding: !!room.isConcluding,
    canConcludeEarly: canConcludeEarly(room),
    settings: room.settings,
    teams: Array.from(room.teams.values()),
    currentPlayer: room.currentPlayer,
    currentBid: room.currentBid,
    highestBidder: room.highestBidder,
    timerSeconds: room.timerSeconds,
    isTimerRunning: room.isTimerRunning,
    auctionIndex: room.auctionIndex,
    totalPlayers: room.playerPool.length,
    recentLogs: room.recentLogs.slice(-30),
    canUndoSkip: room.skipHistory.length > 0,
    unclaimedTeams: IPL_TEAMS.filter(t => !Array.from(room.teams.values()).some(team => team.franchiseId === t.id)),
    foldedTeams: foldedList,
    foldedCount: foldedList.length,
    requiredFolds: requiredFolds,
    standings: room.standings || null,
    spectatorsCount: room.spectators ? room.spectators.size : 0,
    decibelMeter: room.decibelMeter || {}
  };
}

function broadcastRoomUpdate(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  io.to(roomCode).emit('room_update', sanitizeRoomState(room));
}

function addRoomLog(room, message, type = 'info', meta = null) {
  const entry = {
    id: Date.now() + Math.random().toString(36).substring(2, 6),
    time: new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    message,
    type,
    meta
  };
  room.recentLogs.push(entry);
  if (room.recentLogs.length > 100) room.recentLogs.shift();
  io.to(room.code).emit('new_log', entry);
}

function clearRoomTimer(room) {
  if (room.timerInterval) {
    clearInterval(room.timerInterval);
    room.timerInterval = null;
  }
  room.isTimerRunning = false;
}

function startCountdown(room) {
  clearRoomTimer(room);
  room.isTimerRunning = true;
  room.timerSeconds = 15;
  io.to(room.code).emit('timer_tick', { seconds: room.timerSeconds, isRunning: true });

  room.timerInterval = setInterval(() => {
    room.timerSeconds -= 1;
    io.to(room.code).emit('timer_tick', { seconds: room.timerSeconds, isRunning: true });

    if (room.timerSeconds <= 0) {
      clearRoomTimer(room);
      handlePlayerSoldOrUnsold(room);
    }
  }, 1000);
}

function handlePlayerSoldOrUnsold(room) {
  const player = room.currentPlayer;
  if (!player) return;

  if (room.highestBidder) {
    // SOLD!
    const winningTeam = room.teams.get(room.highestBidder.socketId);
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

  // Check Trigger B: Squad capacity or financial saturation
  if (checkCapacityAndFinanceEndCondition(room)) {
    setTimeout(() => {
      triggerAuctionEndSequence(room, 'All participating teams have reached max squad capacity or exhausted purse limits!');
    }, 2500);
    return;
  }

  // 3-second delay before moving to next player
  setTimeout(() => {
    advanceToNextPlayer(room);
  }, 3000);
}

function advanceToNextPlayer(room) {
  if (!rooms.has(room.code)) return;

  room.auctionIndex += 1;
  if (room.auctionIndex < room.playerPool.length) {
    const nextPlayer = room.playerPool[room.auctionIndex];
    room.currentPlayer = nextPlayer;
    room.currentBid = nextPlayer.basePrice;
    room.highestBidder = null;
    room.timerSeconds = 15;
    room.isTimerRunning = false;
    room.foldedTeams = new Set();
    clearRoomTimer(room);

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
    for (const team of room.teams.values()) {
      const squadLen = team.squad ? team.squad.length : 0;
      const osCount = team.overseasCount || 0;
      const canTakeSquad = squadLen < maxSquad;
      const canTakeOS = !nextPlayer.isOverseas || osCount < maxOS;
      const canAfford = team.purse >= basePrice;

      if (canTakeSquad && canTakeOS && canAfford) {
        eligibleBidders += 1;
      }
    }

    if (eligibleBidders === 0 && room.teams.size > 0) {
      addRoomLog(
        room,
        `⚠️ Deadlock prevented: No connected franchise can legally bid on ${nextPlayer.name} (Quota/Purse limits). Auto-passing unsold.`,
        'warning'
      );
      // Pass player as unsold immediately and proceed
      io.to(room.code).emit('player_unsold', { player: nextPlayer });
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
      const roomCode = generateRoomCode();
      const token = data.sessionToken || generateSessionToken();

      // Clone players pool
      const playerPool = JSON.parse(JSON.stringify(playersDataset));

      const decibelMap = {};
      IPL_TEAMS.forEach(t => { decibelMap[t.id] = 50; });

      const newRoom = {
        code: roomCode,
        hostId: socket.id,
        status: 'LOBBY',
        isStarted: false,
        isConcluding: false,
        settings: {
          initialPurse: Number(initialPurse) || 1000000000,
          maxSquadSize: Number(maxSquadSize) || 25,
          minSquadSize: Number(minSquadSize) || 15,
          maxOverseas: Number(maxOverseas) || 8,
          retentionsAllowed: Math.min(Math.max(Number(retentionsAllowed) || 0, 0), 4)
        },
        teams: new Map(),
        spectators: new Map(),
        decibelMeter: decibelMap,
        playerPool,
        unsoldPlayers: [],
        skipHistory: [],
        foldedTeams: new Set(),
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

      rooms.set(roomCode, newRoom);
      socket.join(roomCode);
      socket.roomCode = roomCode;

      sessionRegistry.set(token, {
        roomId: roomCode,
        teamId: null,
        managerName: (managerName || 'Host').trim(),
        socketId: socket.id,
        role: 'manager'
      });

      addRoomLog(newRoom, `Room created [${roomCode}]. Host joined.`);

      if (typeof callback === 'function') {
        callback({ success: true, roomCode, sessionToken: token, roomState: sanitizeRoomState(newRoom) });
      }
    } catch (err) {
      if (typeof callback === 'function') callback({ success: false, error: err.message });
    }
  });

  // 2. Join Room
  socket.on('join_room', ({ roomCode, managerName, sessionToken }, callback) => {
    try {
      if (!roomCode) return callback && callback({ success: false, error: 'Room code is required' });
      const code = roomCode.toUpperCase().trim();
      const room = rooms.get(code);

      if (!room) return callback && callback({ success: false, error: 'Room not found. Check code.' });

      if (room.cleanupTimer) {
        clearTimeout(room.cleanupTimer);
        room.cleanupTimer = null;
      }

      const token = sessionToken || generateSessionToken();
      const mName = (managerName || 'Player').trim();

      // Check manager name duplication inside active room
      const existingNames = Array.from(room.teams.values()).map(t => t.managerName.toLowerCase());
      if (existingNames.includes(mName.toLowerCase())) {
        const registered = sessionRegistry.get(token);
        if (!registered || registered.roomId !== code) {
          return callback && callback({ success: false, error: `Manager handle "${mName}" is already taken in this room. Please choose another.` });
        }
      }

      // 10-Franchise Cap & Automated Spectator Ingestion
      const isLobbyFull = room.teams.size >= 10;
      const isAutoSpectator = room.isStarted || isLobbyFull;

      if (isAutoSpectator) {
        if (!room.spectators) room.spectators = new Map();
        room.spectators.set(socket.id, {
          socketId: socket.id,
          managerName: mName,
          supportedTeam: null,
          sessionToken: token
        });

        socket.join(code);
        socket.roomCode = code;

        sessionRegistry.set(token, {
          roomId: code,
          teamId: null,
          managerName: mName,
          socketId: socket.id,
          role: 'spectator'
        });

        addRoomLog(room, `👁️ ${mName} joined as Spectator.`);

        if (typeof callback === 'function') {
          callback({
            success: true,
            role: 'spectator',
            sessionToken: token,
            roomState: sanitizeRoomState(room)
          });
        }

        broadcastRoomUpdate(code);
        return;
      }

      socket.join(code);
      socket.roomCode = code;

      sessionRegistry.set(token, {
        roomId: code,
        teamId: null,
        managerName: mName,
        socketId: socket.id,
        role: 'manager'
      });

      if (typeof callback === 'function') {
        callback({ success: true, role: 'manager', sessionToken: token, roomState: sanitizeRoomState(room) });
      }

      broadcastRoomUpdate(code);
    } catch (err) {
      if (typeof callback === 'function') callback({ success: false, error: err.message });
    }
  });

  // 2B. Reconnect Player / Resume Session
  const handleReconnect = ({ roomId, roomCode, sessionToken, teamId, franchiseId, managerName }, callback) => {
    try {
      const code = (roomId || roomCode || '').toUpperCase().trim();
      if (!code) return callback && callback({ success: false, error: 'Room code is required' });
      const room = rooms.get(code);

      if (!room) return callback && callback({ success: false, error: 'War Room session expired or not found.' });

      if (room.cleanupTimer) {
        clearTimeout(room.cleanupTimer);
        room.cleanupTimer = null;
      }

      socket.join(code);
      socket.roomCode = code;

      // Re-assign host if old host is disconnected
      const activeSockets = Array.from(io.sockets.adapter.rooms.get(code) || []);
      if (!room.hostId || !activeSockets.includes(room.hostId)) {
        room.hostId = socket.id;
      }

      const fId = franchiseId || teamId;
      let reclaimedTeam = null;

      if (fId) {
        for (const [oldSId, team] of room.teams.entries()) {
          if (team.franchiseId === fId) {
            room.teams.delete(oldSId);
            team.socketId = socket.id;
            if (managerName) team.managerName = managerName.trim();
            team.isHost = (socket.id === room.hostId);
            room.teams.set(socket.id, team);
            reclaimedTeam = team;

            if (room.highestBidder && (room.highestBidder.teamId === fId || room.highestBidder.socketId === oldSId)) {
              room.highestBidder.socketId = socket.id;
            }
            break;
          }
        }
      }

      const token = sessionToken || generateSessionToken();
      let userRole = reclaimedTeam ? 'manager' : 'spectator';

      if (!reclaimedTeam && (room.isStarted || room.teams.size >= 10)) {
        if (!room.spectators) room.spectators = new Map();
        room.spectators.set(socket.id, {
          socketId: socket.id,
          managerName: managerName || 'Spectator',
          supportedTeam: null,
          sessionToken: token
        });
        userRole = 'spectator';
      }

      sessionRegistry.set(token, {
        roomId: code,
        teamId: reclaimedTeam ? reclaimedTeam.franchiseId : null,
        managerName: reclaimedTeam ? reclaimedTeam.managerName : (managerName || 'Manager'),
        socketId: socket.id,
        role: userRole
      });

      addRoomLog(
        room,
        `⚡ ${reclaimedTeam ? reclaimedTeam.managerName : (managerName || 'Player')} reconnected & restored session.`,
        'info'
      );

      const franchiseRoster = reclaimedTeam ? playersDataset.filter(p => p.originalTeam === reclaimedTeam.franchiseId) : [];

      if (typeof callback === 'function') {
        callback({
          success: true,
          reclaimed: !!reclaimedTeam,
          role: userRole,
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

  // 3. Select Team Franchise
  socket.on('select_team', ({ franchiseId, managerName, sessionToken }, callback) => {
    try {
      const roomCode = socket.roomCode;
      const room = rooms.get(roomCode);
      if (!room) return callback && callback({ success: false, error: 'Room not found' });

      // Match-Lock Guard: Once match is started, team selection is strictly locked
      if (room.isStarted || room.status !== 'LOBBY') {
        return callback && callback({ success: false, error: 'Match already started. Franchise selection is locked.' });
      }

      // 10-Franchise Cap Guard
      if (room.teams.size >= 10 && !room.teams.has(socket.id)) {
        return callback && callback({ success: false, error: 'Lobby is full! Max 10 franchises already claimed.' });
      }

      const franchise = IPL_TEAMS.find(t => t.id === franchiseId);
      if (!franchise) return callback && callback({ success: false, error: 'Invalid franchise selected.' });

      // Verify franchise availability
      for (const [sId, existingTeam] of room.teams.entries()) {
        if (existingTeam.franchiseId === franchiseId && sId !== socket.id) {
          return callback && callback({ success: false, error: `${franchise.name} has already been claimed by another player!` });
        }
      }

      const existing = room.teams.get(socket.id);
      const teamData = {
        socketId: socket.id,
        managerName: (managerName || 'Manager').trim(),
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
        isHost: socket.id === room.hostId,
        retentions: existing ? existing.retentions : []
      };

      room.teams.set(socket.id, teamData);

      if (sessionToken && sessionRegistry.has(sessionToken)) {
        sessionRegistry.get(sessionToken).teamId = franchise.id;
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
  socket.on('submit_retentions', ({ playerIds }, callback) => {
    try {
      const roomCode = socket.roomCode;
      const room = rooms.get(roomCode);
      if (!room) return callback && callback({ success: false, error: 'Room not found' });

      const team = room.teams.get(socket.id);
      if (!team) return callback && callback({ success: false, error: 'Select a team first.' });

      // Match-Lock Guard: Once match is started, retentions are locked
      if (room.isStarted || room.status !== 'LOBBY') {
        return callback && callback({ success: false, error: 'Match already started. Retentions are locked.' });
      }

      const selectedIds = Array.isArray(playerIds) ? playerIds.slice(0, room.settings.retentionsAllowed) : [];

      let totalCost = 0;
      const retainedSquad = [];
      let overseas = 0;

      for (let i = 0; i < selectedIds.length; i++) {
        const pId = selectedIds[i];
        const player = playersDataset.find(p => p.id === pId);
        if (player) {
          const cost = RETENTION_COSTS[i] || 100000000;
          totalCost += cost;
          if (player.isOverseas) overseas += 1;
          retainedSquad.push({
            ...player,
            finalPrice: cost,
            acquiredVia: 'RETENTION'
          });
        }
      }

      if (totalCost > room.settings.initialPurse) {
        return callback && callback({ success: false, error: 'Retention cost exceeds total purse!' });
      }

      team.purse = room.settings.initialPurse - totalCost;
      team.squad = retainedSquad;
      team.squadCount = retainedSquad.length;
      team.overseasCount = overseas;
      team.retentions = selectedIds;

      addRoomLog(room, `${team.name} locked in ${selectedIds.length} retention(s). Remaining purse: ₹${(team.purse / 10000000).toFixed(2)} Cr.`);

      if (typeof callback === 'function') callback({ success: true, team });
      broadcastRoomUpdate(roomCode);
    } catch (err) {
      if (typeof callback === 'function') callback({ success: false, error: err.message });
    }
  });

  // 5. Start Auction (Host)
  socket.on('start_auction', (_, callback) => {
    try {
      const roomCode = socket.roomCode;
      const room = rooms.get(roomCode);
      if (!room) return callback && callback({ success: false, error: 'Room not found' });
      if (socket.id !== room.hostId) return callback && callback({ success: false, error: 'Host only' });

      if (room.teams.size === 0) {
        return callback && callback({ success: false, error: 'At least 1 team must join to start!' });
      }

      // Remove all retained players from auction pool
      const retainedPlayerIds = new Set();
      for (const t of room.teams.values()) {
        (t.retentions || []).forEach(id => retainedPlayerIds.add(id));
      }

      room.playerPool = room.playerPool.filter(p => !retainedPlayerIds.has(p.id));

      if (room.playerPool.length === 0) {
        return callback && callback({ success: false, error: 'No players left in pool!' });
      }

      room.isStarted = true;
      room.status = 'AUCTION';
      room.auctionIndex = -1;

      addRoomLog(room, `🚀 Host started the Mega Auction with ${room.playerPool.length} available players!`, 'announcement');
      advanceToNextPlayer(room);

      if (typeof callback === 'function') callback({ success: true });
    } catch (err) {
      if (typeof callback === 'function') callback({ success: false, error: err.message });
    }
  });

  // 5B. Controlled Host Wrap-Up (Accelerated Phase / Manual Finalize)
  socket.on('host_conclude_auction', (_, callback) => {
    try {
      const roomCode = socket.roomCode;
      const room = rooms.get(roomCode);
      if (!room) return callback && callback({ success: false, error: 'Room not found' });
      if (socket.id !== room.hostId) return callback && callback({ success: false, error: 'Host only' });
      if (room.status !== 'AUCTION') return callback && callback({ success: false, error: 'Auction is not currently in progress' });

      if (!canConcludeEarly(room)) {
        const minRequired = (room.settings && room.settings.minSquadSize) || 15;
        return callback && callback({
          success: false,
          error: `All franchises must have at least ${minRequired} players before closing early.`
        });
      }

      triggerAuctionEndSequence(room, 'Host concluded auction & finalized squads.');
      if (typeof callback === 'function') callback({ success: true });
    } catch (err) {
      if (typeof callback === 'function') callback({ success: false, error: err.message });
    }
  });

  // 6. Place Bid (Synchronous Atomic Handling)
  socket.on('place_bid', ({ expectedCurrentBid }, callback) => {
    try {
      const roomCode = socket.roomCode;
      const room = rooms.get(roomCode);
      if (!room) return callback && callback({ success: false, error: 'Room not found' });

      if (room.status !== 'AUCTION' || !room.currentPlayer) {
        return callback && callback({ success: false, error: 'No active player on hammer.' });
      }

      const team = room.teams.get(socket.id);
      if (!team) return callback && callback({ success: false, error: 'You have not claimed a team franchise.' });

      // Guard: Highest bidder cannot bid against themselves
      if (room.highestBidder && room.highestBidder.socketId === socket.id) {
        return callback && callback({ success: false, error: 'You already hold the highest bid!' });
      }

      // Check max squad size
      if (team.squad.length >= room.settings.maxSquadSize) {
        return callback && callback({ success: false, error: `Squad capacity full (${room.settings.maxSquadSize} max)!` });
      }

      // Check overseas limit
      if (room.currentPlayer.isOverseas && team.overseasCount >= room.settings.maxOverseas) {
        return callback && callback({ success: false, error: `Overseas player limit reached (${room.settings.maxOverseas} max)!` });
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
      room.currentBid = nextBidAmount;
      room.highestBidder = {
        socketId: socket.id,
        teamId: team.franchiseId,
        teamName: team.name,
        managerName: team.managerName,
        logo: team.logo,
        color: team.color
      };

      // Reset consensus folds for new price point
      room.foldedTeams = new Set();

      addRoomLog(
        room,
        `💰 ${team.name} (${team.franchiseId}) raised bid to ₹${(nextBidAmount / 10000000).toFixed(2)} Cr!`,
        'bid',
        { teamName: team.name, teamId: team.franchiseId, bid: nextBidAmount }
      );

      // Reset countdown to 15 seconds
      startCountdown(room);

      io.to(room.code).emit('bid_accepted', {
        currentBid: room.currentBid,
        highestBidder: room.highestBidder,
        nextIncrement: calculateIncrement(room.currentBid)
      });

      if (typeof callback === 'function') {
        callback({ success: true, currentBid: room.currentBid });
      }
    } catch (err) {
      if (typeof callback === 'function') callback({ success: false, error: err.message });
    }
  });

  // 7. Host Skip Player
  socket.on('skip_player', (_, callback) => {
    try {
      const roomCode = socket.roomCode;
      const room = rooms.get(roomCode);
      if (!room) return callback && callback({ success: false, error: 'Room not found' });
      if (socket.id !== room.hostId) return callback && callback({ success: false, error: 'Host only' });
      if (room.status !== 'AUCTION' || !room.currentPlayer) {
        return callback && callback({ success: false, error: 'No player on hammer to skip' });
      }

      clearRoomTimer(room);

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
  socket.on('undo_skip_player', (_, callback) => {
    try {
      const roomCode = socket.roomCode;
      const room = rooms.get(roomCode);
      if (!room) return callback && callback({ success: false, error: 'Room not found' });
      if (socket.id !== room.hostId) return callback && callback({ success: false, error: 'Host only' });
      if (room.skipHistory.length === 0) {
        return callback && callback({ success: false, error: 'No skipped player to undo' });
      }

      clearRoomTimer(room);

      const lastSkipped = room.skipHistory.pop();
      room.playerPool.pop(); // Remove the duplicated entry pushed to the end

      room.currentPlayer = lastSkipped.player;
      room.currentBid = lastSkipped.player.basePrice;
      room.highestBidder = null;
      room.timerSeconds = 15;
      room.isTimerRunning = false;
      room.foldedTeams = new Set();

      addRoomLog(room, `⏪ Host restored skipped star: ${lastSkipped.player.name}!`, 'announcement');
      broadcastRoomUpdate(roomCode);

      if (typeof callback === 'function') callback({ success: true, player: lastSkipped.player });
    } catch (err) {
      if (typeof callback === 'function') callback({ success: false, error: err.message });
    }
  });

  // 9. Team FOLD / Pass (Consensus skip timer)
  socket.on('team_fold', (_, callback) => {
    try {
      const roomCode = socket.roomCode;
      const room = rooms.get(roomCode);
      if (!room) return callback && callback({ success: false, error: 'Room not found' });
      if (room.status !== 'AUCTION' || !room.currentPlayer) {
        return callback && callback({ success: false, error: 'No active player on hammer' });
      }

      const team = room.teams.get(socket.id);
      if (!team) return callback && callback({ success: false, error: 'Select a team first' });

      // Security: Leading/Highest bidder CANNOT fold against their own bid!
      if (room.highestBidder && (room.highestBidder.socketId === socket.id || room.highestBidder.teamId === team.franchiseId)) {
        return callback && callback({ success: false, error: 'You are the highest bidder! Leading team cannot fold.' });
      }

      if (!room.foldedTeams) room.foldedTeams = new Set();
      if (room.highestBidder) {
        room.foldedTeams.delete(room.highestBidder.teamId);
      }
      room.foldedTeams.add(team.franchiseId);

      addRoomLog(
        room,
        `✋ ${team.name} (${team.franchiseId}) folded on ${room.currentPlayer.name}.`,
        'info'
      );

      const requiredFolds = room.highestBidder ? Math.max(room.teams.size - 1, 1) : Math.max(room.teams.size, 1);

      if (room.foldedTeams.size >= requiredFolds) {
        clearRoomTimer(room);
        addRoomLog(
          room,
          `⚡ Consensus reached! All non-leading franchises folded on ${room.currentPlayer.name}. Instant hammer!`,
          'announcement'
        );
        io.to(room.code).emit('all_teams_folded', {
          player: room.currentPlayer,
          highestBidder: room.highestBidder
        });
        handlePlayerSoldOrUnsold(room);
        if (typeof callback === 'function') callback({ success: true, folded: true, allFolded: true });
        return;
      }

      broadcastRoomUpdate(roomCode);
      if (typeof callback === 'function') callback({ success: true, folded: true, allFolded: false });
    } catch (err) {
      if (typeof callback === 'function') callback({ success: false, error: err.message });
    }
  });

  // 9B. Spectator Cheer & Decibel Hype Event
  socket.on('spectator_cheer', ({ teamId, cheerType, cheerEmoji }, callback) => {
    try {
      const roomCode = socket.roomCode;
      const room = rooms.get(roomCode);
      if (!room) return callback && callback({ success: false, error: 'Room not found' });

      if (!room.decibelMeter) {
        room.decibelMeter = {};
        IPL_TEAMS.forEach(t => { room.decibelMeter[t.id] = 50; });
      }

      const validTypes = ['horn', 'fire', 'applause', 'lightning', 'chant'];
      const cType = validTypes.includes(cheerType) ? cheerType : 'applause';

      const targetTeam = teamId && IPL_TEAMS.some(t => t.id === teamId) 
        ? teamId 
        : (room.highestBidder ? room.highestBidder.teamId : 'CSK');

      const boost = cType === 'lightning' ? 8 : (cType === 'horn' || cType === 'chant' ? 5 : 3);
      room.decibelMeter[targetTeam] = Math.min(100, (room.decibelMeter[targetTeam] || 50) + boost);

      io.to(room.code).emit('broadcast_cheer', {
        teamId: targetTeam,
        cheerType: cType,
        cheerEmoji: cheerEmoji || '👏',
        currentDecibel: room.decibelMeter[targetTeam]
      });

      if (typeof callback === 'function') callback({ success: true, decibel: room.decibelMeter[targetTeam] });
    } catch (err) {
      if (typeof callback === 'function') callback({ success: false, error: err.message });
    }
  });

  // 10. Disconnect
  socket.on('disconnect', () => {
    const roomCode = socket.roomCode;
    if (!roomCode) return;
    const room = rooms.get(roomCode);
    if (!room) return;

    if (room.spectators && room.spectators.has(socket.id)) {
      room.spectators.delete(socket.id);
    }

    const leavingTeam = room.teams.get(socket.id);
    if (leavingTeam) {
      addRoomLog(room, `⚠️ ${leavingTeam.managerName} (${leavingTeam.franchiseId}) disconnected.`);
    }

    if (socket.id === room.hostId) {
      const remainingSockets = Array.from(io.sockets.adapter.rooms.get(roomCode) || []);
      if (remainingSockets.length > 0) {
        room.hostId = remainingSockets[0];
        addRoomLog(room, `👑 Host disconnected. New host assigned.`);
      } else {
        // Cache grace period: keep room alive for 5 minutes in memory so user can reconnect without losing progress
        if (!room.cleanupTimer) {
          room.cleanupTimer = setTimeout(() => {
            const currentSockets = Array.from(io.sockets.adapter.rooms.get(roomCode) || []);
            if (currentSockets.length === 0) {
              clearRoomTimer(room);
              rooms.delete(roomCode);
              console.log(`[CLEANUP] Room ${roomCode} wiped from memory after 5 min idle.`);
            }
          }, 5 * 60 * 1000);
        }
      }
    }

    broadcastRoomUpdate(roomCode);
  });

  // 11. Leave Match (Explicit Cleanup)
  socket.on('leave_match', ({ sessionToken }, callback) => {
    try {
      const roomCode = socket.roomCode;
      if (sessionToken && sessionRegistry.has(sessionToken)) {
        sessionRegistry.delete(sessionToken);
      }
      if (roomCode) {
        const room = rooms.get(roomCode);
        if (room && room.spectators) {
          room.spectators.delete(socket.id);
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
