const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

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

// Load static players dataset
const playersFilePath = path.join(__dirname, 'players.json');
let playersDataset = [];
try {
  const rawData = fs.readFileSync(playersFilePath, 'utf-8');
  playersDataset = JSON.parse(rawData);
  console.log(`[IPL SERVER] Successfully loaded ${playersDataset.length} players.`);
} catch (err) {
  console.error('[IPL SERVER] Error loading players.json:', err.message);
  process.exit(1);
}

// In-Memory Storage for Auction Rooms (Zero external DB)
const rooms = new Map();

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

function sanitizeRoomState(room) {
  const foldedList = Array.from(room.foldedTeams || []);
  const requiredFolds = room.highestBidder ? Math.max(room.teams.size - 1, 1) : Math.max(room.teams.size, 1);
  return {
    code: room.code,
    hostId: room.hostId,
    status: room.status,
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
    requiredFolds: requiredFolds
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
        `🔨 SOLD! ${player.name} sold to ${winningTeam.name} (${winningTeam.franchiseId}) for ₹${(room.currentBid / 10000000).toFixed(2)} Cr!`,
        'sold',
        { playerName: player.name, teamName: winningTeam.name, teamId: winningTeam.franchiseId, price: room.currentBid }
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
    room.isTimerRunning = false; // Note: Timer does NOT start until someone bids!
    room.foldedTeams = new Set();
    clearRoomTimer(room);

    addRoomLog(
      room,
      `📢 Next on hammer: ${nextPlayer.name} (${nextPlayer.role}, ${nextPlayer.isOverseas ? '✈️ Overseas' : '🇮🇳 Indian'}) - Base: ₹${(nextPlayer.basePrice / 10000000).toFixed(2)} Cr`,
      'announcement'
    );

    broadcastRoomUpdate(room.code);
  } else {
    // AUCTION COMPLETED
    room.status = 'FINISHED';
    room.currentPlayer = null;
    room.highestBidder = null;
    room.foldedTeams = new Set();
    clearRoomTimer(room);
    addRoomLog(room, `🏆 AUCTION COMPLETED! All players in pool have been presented.`, 'finish');
    broadcastRoomUpdate(room.code);
  }
}

// Socket.IO Connection
io.on('connection', (socket) => {
  // 1. Create Room
  socket.on('create_room', (data, callback) => {
    try {
      const { initialPurse = 1000000000, maxSquadSize = 25, maxOverseas = 8, retentionsAllowed = 2 } = data || {};
      const roomCode = generateRoomCode();

      // Clone players pool
      const playerPool = JSON.parse(JSON.stringify(playersDataset));

      const newRoom = {
        code: roomCode,
        hostId: socket.id,
        status: 'LOBBY',
        settings: {
          initialPurse: Number(initialPurse) || 1000000000,
          maxSquadSize: Number(maxSquadSize) || 25,
          maxOverseas: Number(maxOverseas) || 8,
          retentionsAllowed: Math.min(Math.max(Number(retentionsAllowed) || 0, 0), 4)
        },
        teams: new Map(),
        playerPool,
        unsoldPlayers: [],
        skipHistory: [], // Host undo skip stack
        foldedTeams: new Set(),
        auctionIndex: -1,
        currentPlayer: null,
        currentBid: 0,
        highestBidder: null,
        timerSeconds: 15,
        isTimerRunning: false,
        timerInterval: null,
        recentLogs: []
      };

      rooms.set(roomCode, newRoom);
      socket.join(roomCode);
      socket.roomCode = roomCode;

      addRoomLog(newRoom, `Room created [${roomCode}]. Host joined.`);

      if (typeof callback === 'function') {
        callback({ success: true, roomCode, roomState: sanitizeRoomState(newRoom) });
      }
    } catch (err) {
      if (typeof callback === 'function') callback({ success: false, error: err.message });
    }
  });

  // 2. Join Room
  socket.on('join_room', ({ roomCode }, callback) => {
    try {
      if (!roomCode) return callback && callback({ success: false, error: 'Room code is required' });
      const code = roomCode.toUpperCase().trim();
      const room = rooms.get(code);

      if (!room) return callback && callback({ success: false, error: 'Room not found. Check code.' });

      socket.join(code);
      socket.roomCode = code;

      if (typeof callback === 'function') {
        callback({ success: true, roomState: sanitizeRoomState(room) });
      }

      broadcastRoomUpdate(code);
    } catch (err) {
      if (typeof callback === 'function') callback({ success: false, error: err.message });
    }
  });

  // 3. Select Team Franchise
  socket.on('select_team', ({ franchiseId, managerName }, callback) => {
    try {
      const roomCode = socket.roomCode;
      const room = rooms.get(roomCode);
      if (!room) return callback && callback({ success: false, error: 'Room not found' });

      if (room.status !== 'LOBBY' && room.status !== 'RETENTION') {
        return callback && callback({ success: false, error: 'Auction already started. Cannot switch team.' });
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
      addRoomLog(room, `${teamData.managerName} took control of ${teamData.name} (${teamData.franchiseId})`);

      // Provide the franchise's real player retention roster immediately
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

      if (room.status !== 'LOBBY' && room.status !== 'RETENTION') {
        return callback && callback({ success: false, error: 'Retentions only allowed before auction start.' });
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

      room.status = 'AUCTION';
      room.auctionIndex = -1;

      addRoomLog(room, `🚀 Host started the Mega Auction with ${room.playerPool.length} available players!`, 'announcement');
      advanceToNextPlayer(room);

      if (typeof callback === 'function') callback({ success: true });
    } catch (err) {
      if (typeof callback === 'function') callback({ success: false, error: err.message });
    }
  });

  // 6. Place Bid (Synchronous Atomic Handling in Event Loop)
  socket.on('place_bid', ({ expectedCurrentBid }, callback) => {
    try {
      const roomCode = socket.roomCode;
      const room = rooms.get(roomCode);
      if (!room) return callback && callback({ success: false, error: 'Room not found' });

      if (room.status !== 'AUCTION' || !room.currentPlayer) {
        return callback && callback({ success: false, error: 'No active player on hammer.' });
      }

      const team = room.teams.get(socket.id);
      if (!team) return callback && callback({ success: false, error: 'You must select a team to bid!' });

      // Concurrency check
      if (expectedCurrentBid !== undefined && expectedCurrentBid !== room.currentBid) {
        return callback && callback({
          success: false,
          error: 'Bid rejected: Price increased',
          serverCurrentBid: room.currentBid
        });
      }

      // Already highest bidder check
      if (room.highestBidder && room.highestBidder.socketId === socket.id) {
        return callback && callback({ success: false, error: 'Your team is already the highest bidder!' });
      }

      // Next bid amount
      let nextBidAmount;
      if (!room.highestBidder) {
        // First bid starts at Base Price!
        nextBidAmount = room.currentPlayer.basePrice;
      } else {
        const increment = calculateIncrement(room.currentBid);
        nextBidAmount = room.currentBid + increment;
      }

      // Purse check
      if (team.purse < nextBidAmount) {
        return callback && callback({
          success: false,
          error: `Insufficient purse! Needed ₹${(nextBidAmount / 10000000).toFixed(2)} Cr.`
        });
      }

      // Squad slot check
      if (team.squad.length >= room.settings.maxSquadSize) {
        return callback && callback({ success: false, error: `Squad full (${room.settings.maxSquadSize} max)!` });
      }

      // Overseas check
      if (room.currentPlayer.isOverseas && team.overseasCount >= room.settings.maxOverseas) {
        return callback && callback({ success: false, error: `Overseas quota full (${room.settings.maxOverseas} max)!` });
      }

      // Buffer purse reserve check (reserve 20L per remaining unfilled slot)
      const remainingSlots = room.settings.maxSquadSize - team.squad.length - 1;
      const minRequiredBuffer = remainingSlots * 2000000;
      if ((team.purse - nextBidAmount) < minRequiredBuffer && remainingSlots > 0) {
        return callback && callback({
          success: false,
          error: `Reserve needed: Keep ₹${(minRequiredBuffer / 10000000).toFixed(2)} Cr to complete squad!`
        });
      }

      // Accept Bid!
      room.currentBid = nextBidAmount;
      room.highestBidder = {
        socketId: socket.id,
        teamId: team.franchiseId,
        teamName: team.name,
        color: team.color,
        logo: team.logo,
        managerName: team.managerName
      };

      // Reset team folds since price changed
      if (room.foldedTeams) room.foldedTeams.clear();

      // Starts/Resets countdown timer to 15s ONLY AFTER a bid is placed!
      startCountdown(room);

      addRoomLog(
        room,
        `💰 ${team.franchiseId} bid ₹${(nextBidAmount / 10000000).toFixed(2)} Cr for ${room.currentPlayer.name}`,
        'bid',
        { playerName: room.currentPlayer.name, teamId: team.franchiseId, teamName: team.name, amount: nextBidAmount }
      );

      io.to(room.code).emit('bid_accepted', {
        currentBid: room.currentBid,
        highestBidder: room.highestBidder,
        nextIncrement: calculateIncrement(room.currentBid),
        timerSeconds: 15
      });
      broadcastRoomUpdate(room.code);

      if (typeof callback === 'function') {
        callback({ success: true, currentBid: room.currentBid });
      }
    } catch (err) {
      if (typeof callback === 'function') callback({ success: false, error: err.message });
    }
  });

  // 7. Host Skip / Pass Player
  socket.on('skip_player', (_, callback) => {
    try {
      const roomCode = socket.roomCode;
      const room = rooms.get(roomCode);
      if (!room) return callback && callback({ success: false, error: 'Room not found' });
      if (socket.id !== room.hostId) return callback && callback({ success: false, error: 'Host only' });

      if (!room.currentPlayer) return callback && callback({ success: false, error: 'No active player to skip' });

      // Save state into skipHistory for Undo
      room.skipHistory.push({
        auctionIndex: room.auctionIndex,
        player: room.currentPlayer,
        currentBid: room.currentBid,
        highestBidder: room.highestBidder
      });

      addRoomLog(room, `⏩ Host skipped ${room.currentPlayer.name}`, 'warning');
      clearRoomTimer(room);
      handlePlayerSoldOrUnsold(room);

      if (typeof callback === 'function') callback({ success: true });
    } catch (err) {
      if (typeof callback === 'function') callback({ success: false, error: err.message });
    }
  });

  // 8. Host Undo Skip Player
  socket.on('undo_skip_player', (_, callback) => {
    try {
      const roomCode = socket.roomCode;
      const room = rooms.get(roomCode);
      if (!room) return callback && callback({ success: false, error: 'Room not found' });
      if (socket.id !== room.hostId) return callback && callback({ success: false, error: 'Host only' });

      if (room.skipHistory.length === 0) {
        return callback && callback({ success: false, error: 'No recently skipped player to restore' });
      }

      const lastSkipped = room.skipHistory.pop();
      clearRoomTimer(room);

      // Re-insert player at current index
      room.playerPool.splice(room.auctionIndex, 0, lastSkipped.player);
      room.currentPlayer = lastSkipped.player;
      room.currentBid = lastSkipped.player.basePrice;
      room.highestBidder = null;
      room.timerSeconds = 15;
      room.isTimerRunning = false;

      // Remove from unsold list if it was recorded
      const uIndex = room.unsoldPlayers.findIndex(p => p.id === lastSkipped.player.id);
      if (uIndex !== -1) room.unsoldPlayers.splice(uIndex, 1);

      addRoomLog(room, `↩️ Host UNDID the skip! Restored ${lastSkipped.player.name} to the auction hammer.`, 'announcement');
      broadcastRoomUpdate(room.code);

      if (typeof callback === 'function') callback({ success: true });
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

      // Leading bidder cannot fold against their own bid
      if (room.highestBidder && room.highestBidder.socketId === socket.id) {
        return callback && callback({ success: false, error: 'You are already the leading bidder!' });
      }

      if (!room.foldedTeams) room.foldedTeams = new Set();
      room.foldedTeams.add(team.franchiseId);

      addRoomLog(
        room,
        `✋ ${team.name} (${team.franchiseId}) folded on ${room.currentPlayer.name}.`,
        'info'
      );

      // Check consensus:
      // Required folds: if there's a highest bidder, everyone else must fold (teams.size - 1).
      // If no highest bidder, all teams must fold (teams.size).
      const requiredFolds = room.highestBidder ? Math.max(room.teams.size - 1, 1) : Math.max(room.teams.size, 1);

      // If consensus reached among remaining teams:
      if (room.teams.size > 1 && room.foldedTeams.size >= requiredFolds) {
        addRoomLog(
          room,
          `⚡ ALL REMAINING TEAMS FOLDED! Instant hammer fall for ${room.currentPlayer.name}!`,
          'announcement'
        );
        clearRoomTimer(room);
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

  // 10. Disconnect
  socket.on('disconnect', () => {
    const roomCode = socket.roomCode;
    if (!roomCode) return;
    const room = rooms.get(roomCode);
    if (!room) return;

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
        clearRoomTimer(room);
        rooms.delete(roomCode);
        console.log(`[CLEANUP] Room ${roomCode} wiped from memory.`);
        return;
      }
    }

    broadcastRoomUpdate(roomCode);
  });
});

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

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🏏 IPL AUCTION SERVER RUNNING ON PORT ${PORT}`);
});
