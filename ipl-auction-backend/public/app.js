// Official Cloud Backend URL on Render
const CLOUD_BACKEND_URL = 'https://ipl-auction-backend-83zt.onrender.com';

// Server connection status elements
const serverStatusDot = document.getElementById('serverStatusDot');
const serverStatusLabel = document.getElementById('serverStatusLabel');
const welcomeStatusDot = document.getElementById('welcomeStatusDot');
const activeModeBadge = document.getElementById('activeModeBadge');

function updateServerUI(status, label) {
  if (serverStatusDot) {
    if (status === 'connected') {
      serverStatusDot.className = 'w-2 h-2 rounded-full bg-emerald-500';
    } else if (status === 'connecting') {
      serverStatusDot.className = 'w-2 h-2 rounded-full bg-amber-400 animate-pulse';
    } else {
      serverStatusDot.className = 'w-2 h-2 rounded-full bg-rose-500';
    }
  }
  if (welcomeStatusDot) {
    welcomeStatusDot.className = (status === 'connected') 
      ? 'w-2.5 h-2.5 rounded-full bg-emerald-500 shadow-sm shadow-emerald-500/50' 
      : (status === 'connecting') 
      ? 'w-2.5 h-2.5 rounded-full bg-amber-400 animate-pulse' 
      : 'w-2.5 h-2.5 rounded-full bg-rose-500';
  }
  if (serverStatusLabel) {
    serverStatusLabel.textContent = label;
    if (status === 'connected') {
      serverStatusLabel.className = 'hidden sm:inline text-[11px] font-semibold text-emerald-400';
    } else if (status === 'connecting') {
      serverStatusLabel.className = 'hidden sm:inline text-[11px] font-semibold text-amber-400';
    } else {
      serverStatusLabel.className = 'hidden sm:inline text-[11px] font-semibold text-rose-400';
    }
  }
  if (activeModeBadge) {
    if (status === 'connected') {
      activeModeBadge.textContent = 'Cloud Live';
      activeModeBadge.className = 'text-[10px] font-extrabold px-2.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30';
    } else if (status === 'connecting') {
      activeModeBadge.textContent = 'Waking Server...';
      activeModeBadge.className = 'text-[10px] font-extrabold px-2.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/30 animate-pulse';
    } else {
      activeModeBadge.textContent = 'Sleeping (Idle)';
      activeModeBadge.className = 'text-[10px] font-extrabold px-2.5 py-0.5 rounded-full bg-slate-500/20 text-slate-400 border border-slate-500/30';
    }
  }
}

// Resilient Socket.IO client creation
let socket = null;

function initSocket() {
  if (socket) return socket;
  if (typeof io === 'undefined') {
    console.warn('[IPL] Socket.IO library is loading, deferred initialization...');
    return null;
  }

  try {
    const opts = {
      transports: ['websocket', 'polling'],
      timeout: 25000,
      reconnection: true,
      reconnectionAttempts: 30,
      reconnectionDelay: 1000
    };

    updateServerUI('connecting', 'Connecting...');

    // Always connect directly to Render backend
    socket = io(CLOUD_BACKEND_URL, opts);

    socket.on('connect', () => {
      console.log('[IPL] Connected to cloud! Socket ID:', socket.id);
      updateServerUI('connected', 'Cloud Live');
    });

    socket.on('connect_error', (err) => {
      console.warn('[IPL] Server waking up...', err.message);
      updateServerUI('connecting', 'Waking Server...');
    });

    socket.on('disconnect', () => {
      updateServerUI('disconnected', 'Disconnected');
    });

    if (typeof registerSocketAuctionListeners === 'function') {
      registerSocketAuctionListeners(socket);
    }

    return socket;
  } catch (e) {
    console.error('[IPL] Socket initialization error:', e);
    return null;
  }
}

// Allow user to tap status badge to check connection or reconnect
const btnServerConfig = document.getElementById('btnServerConfig');
if (btnServerConfig) {
  btnServerConfig.addEventListener('click', () => {
    if (socket && socket.connected) {
      showToast('Connected to Cloud Server (Active)', 'success');
    } else {
      showToast('Reconnecting to Cloud Server...', 'info');
      initSocket();
    }
  });
}

// Render Free-Tier Sleep Protection:
// If completely idle for 5 minutes without creating/joining a room, disconnect to let Render sleep.
let idleTimer = null;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  // Auto-reconnect if user returns and is not in a room
  if (!socket && !currentRoom) {
    initSocket();
  }
  // Disconnect after 5 minutes of total inactivity (only if not inside an active room)
  idleTimer = setTimeout(() => {
    if (socket && !currentRoom) {
      console.log('[IPL] 5 minutes idle — disconnecting socket to let Render sleep.');
      socket.disconnect();
      socket = null;
      updateServerUI('disconnected', 'Sleeping (Idle)');
    }
  }, IDLE_TIMEOUT_MS);
}

// Reset idle timer on user touch or click
['click', 'touchstart', 'keydown'].forEach(event => {
  window.addEventListener(event, resetIdleTimer, { passive: true });
});
resetIdleTimer();

// Connect immediately on page load
if (typeof io !== 'undefined') {
  initSocket();
} else {
  window.addEventListener('load', () => {
    if (!socket && typeof io !== 'undefined') {
      initSocket();
    }
  });
}

// Application State
let currentRoom = null;
let myTeam = null;
let isHost = false;
let mySelectedRetentions = [];
let currentFranchiseRoster = [];
let currentRetentionFilter = 'ALL';
let currentRetentionSearch = '';
const RETENTION_COSTS = [180000000, 140000000, 110000000, 180000000, 140000000];
let isBidCooldown = false;
let isVoiceEnabled = true;

// Web Speech API Voice Commentary Synthesizer
function speakCommentary(text) {
  if (!isVoiceEnabled || !('speechSynthesis' in window)) return;
  try {
    window.speechSynthesis.cancel(); // clear queue for instant commentary
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.05;
    utterance.pitch = 1.0;
    
    // Choose an English voice
    const voices = window.speechSynthesis.getVoices();
    const naturalVoice = voices.find(v => v.lang.includes('en') && (v.name.includes('Natural') || v.name.includes('Google') || v.name.includes('India') || v.name.includes('Cricket')));
    if (naturalVoice) utterance.voice = naturalVoice;
    
    window.speechSynthesis.speak(utterance);
  } catch (e) {
    // voice blocked
  }
}

// Audio synth helper for sound effects (Web Audio API)
let audioCtx = null;
function getAudioContext() {
  if (!audioCtx) {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    } catch (e) {
      console.warn('[IPL] AudioContext not supported:', e);
    }
  }
  return audioCtx;
}

function playBeep(freq = 440, type = 'sine', duration = 0.15) {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime);
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + duration);
  } catch (e) {}
}

function playHammerSound() {
  playBeep(180, 'square', 0.25);
  setTimeout(() => playBeep(90, 'triangle', 0.35), 100);
}

function playBidSound() {
  playBeep(659.25, 'triangle', 0.1);
  setTimeout(() => playBeep(880, 'sine', 0.15), 60);
}

// Franchise Configuration List
const FRANCHISES = [
  { id: 'CSK', name: 'Chennai Super Kings', color: '#FDB913', logo: '/logos/CSK.svg' },
  { id: 'RCB', name: 'Royal Challengers Bengaluru', color: '#DA1717', logo: '/logos/RCB.svg' },
  { id: 'MI', name: 'Mumbai Indians', color: '#004BA0', logo: '/logos/MI.svg' },
  { id: 'KKR', name: 'Kolkata Knight Riders', color: '#3A225D', logo: '/logos/KKR.svg' },
  { id: 'SRH', name: 'Sunrisers Hyderabad', color: '#F26522', logo: '/logos/SRH.svg' },
  { id: 'RR', name: 'Rajasthan Royals', color: '#EA1A85', logo: '/logos/RR.svg' },
  { id: 'DC', name: 'Delhi Capitals', color: '#17449E', logo: '/logos/DC.svg' },
  { id: 'LSG', name: 'Lucknow Super Giants', color: '#00BFFF', logo: '/logos/LSG.svg' },
  { id: 'GT', name: 'Gujarat Titans', color: '#1B2133', logo: '/logos/GT.svg' },
  { id: 'PBKS', name: 'Punjab Kings', color: '#D71920', logo: '/logos/PBKS.svg' }
];

// Currency formatting
function formatCurrency(amount) {
  if (amount >= 10000000) {
    const cr = (amount / 10000000).toFixed(2);
    return `₹${cr} Cr`;
  } else {
    const lk = (amount / 100000).toFixed(1);
    return `₹${lk} Lakhs`;
  }
}

function calculateIncrement(currentBid) {
  if (currentBid < 10000000) return 2000000;
  if (currentBid < 50000000) return 2500000;
  if (currentBid < 100000000) return 5000000;
  return 10000000;
}

// DOM Elements
const viewWelcome = document.getElementById('viewWelcome');
const viewLobby = document.getElementById('viewLobby');
const viewAuction = document.getElementById('viewAuction');
const viewFinished = document.getElementById('viewFinished');

const btnTabCreate = document.getElementById('btnTabCreate');
const btnTabJoin = document.getElementById('btnTabJoin');
const formCreateRoom = document.getElementById('formCreateRoom');
const formJoinRoom = document.getElementById('formJoinRoom');

const inputManagerName = document.getElementById('inputManagerName');
const btnSubmitCreateRoom = document.getElementById('btnSubmitCreateRoom');
const btnSubmitJoinRoom = document.getElementById('btnSubmitJoinRoom');
const inputJoinRoomCode = document.getElementById('inputJoinRoomCode');

const roomBadge = document.getElementById('roomBadge');
const currentRoomCode = document.getElementById('currentRoomCode');
const lobbyRoomCode = document.getElementById('lobbyRoomCode');
const btnCopyCode = document.getElementById('btnCopyCode');
const hostNotice = document.getElementById('hostNotice');
const btnStartAuctionHost = document.getElementById('btnStartAuctionHost');
const btnHostSkipPlayer = document.getElementById('btnHostSkipPlayer');
const btnHostUndoSkipPlayer = document.getElementById('btnHostUndoSkipPlayer');

const franchiseGrid = document.getElementById('franchiseGrid');

// Lobby Retention Banner Elements
const retentionBanner = document.getElementById('retentionBanner');
const bannerTeamLogo = document.getElementById('bannerTeamLogo');
const bannerTeamName = document.getElementById('bannerTeamName');
const bannerPurseDisplay = document.getElementById('bannerPurseDisplay');
const bannerMaxRetentions = document.getElementById('bannerMaxRetentions');
const bannerRetentionsCountBadge = document.getElementById('bannerRetentionsCountBadge');
const bannerRetainedNames = document.getElementById('bannerRetainedNames');
const btnOpenRetentionModal = document.getElementById('btnOpenRetentionModal');

// Dedicated Retention Modal Elements
const retentionModal = document.getElementById('retentionModal');
const closeRetentionModalBtn = document.getElementById('closeRetentionModalBtn');
const modalRetentionLogo = document.getElementById('modalRetentionLogo');
const modalRetentionTeamName = document.getElementById('modalRetentionTeamName');
const modalMaxRetentions = document.getElementById('modalMaxRetentions');
const modalInitialPurse = document.getElementById('modalInitialPurse');
const modalDeductionPurse = document.getElementById('modalDeductionPurse');
const modalRemainingPurse = document.getElementById('modalRemainingPurse');
const modalSelectedCountBadge = document.getElementById('modalSelectedCountBadge');
const modalCountAll = document.getElementById('modalCountAll');
const searchRetentionPlayer = document.getElementById('searchRetentionPlayer');
const modalRetentionPlayersGrid = document.getElementById('modalRetentionPlayersGrid');
const btnSkipRetentions = document.getElementById('btnSkipRetentions');
const btnSaveRetentionsModal = document.getElementById('btnSaveRetentionsModal');

const userFranchisePill = document.getElementById('userFranchisePill');
const userFranchiseLogo = document.getElementById('userFranchiseLogo');
const userFranchiseTag = document.getElementById('userFranchiseTag');
const userPurseDisplay = document.getElementById('userPurseDisplay');

const toggleVoiceBtn = document.getElementById('toggleVoiceBtn');
const voiceIcon = document.getElementById('voiceIcon');

// Player Card
const playerName = document.getElementById('playerName');
const playerBatBowlStyle = document.getElementById('playerBatBowlStyle');
const playerImage = document.getElementById('playerImage');
const playerRoleBadge = document.getElementById('playerRoleBadge');
const playerCountryBadge = document.getElementById('playerCountryBadge');
const playerTierBadge = document.getElementById('playerTierBadge');
const playerOriginalTeam = document.getElementById('playerOriginalTeam');
const playerBasePrice = document.getElementById('playerBasePrice');
const auctionTimer = document.getElementById('auctionTimer');
const playerSoldWatermark = document.getElementById('playerSoldWatermark');
const playerUnsoldWatermark = document.getElementById('playerUnsoldWatermark');

const stat1 = document.getElementById('stat1');
const stat2 = document.getElementById('stat2');
const stat3 = document.getElementById('stat3');
const stat4 = document.getElementById('stat4');
const statLabel2 = document.getElementById('statLabel2');
const statLabel3 = document.getElementById('statLabel3');
const statLabel4 = document.getElementById('statLabel4');

const currentBidAmount = document.getElementById('currentBidAmount');
const highestBidderName = document.getElementById('highestBidderName');
const highestBidderBadge = document.getElementById('highestBidderBadge');
const highestBidderLogoImg = document.getElementById('highestBidderLogoImg');
const highestBidderPlaceholderIcon = document.getElementById('highestBidderPlaceholderIcon');

// Action Area
const btnPlaceBid = document.getElementById('btnPlaceBid');
const bidButtonText = document.getElementById('bidButtonText');
const btnFoldPlayer = document.getElementById('btnFoldPlayer');
const foldButtonText = document.getElementById('foldButtonText');
const foldStatusBar = document.getElementById('foldStatusBar');
const foldCountDisplay = document.getElementById('foldCountDisplay');
const foldStatusHint = document.getElementById('foldStatusHint');
const bidStatusNotice = document.getElementById('bidStatusNotice');
const myPurseAmount = document.getElementById('myPurseAmount');
const mySquadCount = document.getElementById('mySquadCount');
const myOverseasCount = document.getElementById('myOverseasCount');
const liveFeedTicker = document.getElementById('liveFeedTicker');

// Drawers & Modals
const toggleDrawerBtn = document.getElementById('toggleDrawerBtn');
const closeTeamsDrawerBtn = document.getElementById('closeTeamsDrawerBtn');
const teamsDrawer = document.getElementById('teamsDrawer');
const drawerTeamsList = document.getElementById('drawerTeamsList');
const teamsCountBadge = document.getElementById('teamsCountBadge');

const toggleLogsBtn = document.getElementById('toggleLogsBtn');
const closeLogsDrawerBtn = document.getElementById('closeLogsDrawerBtn');
const logsDrawer = document.getElementById('logsDrawer');
const fullLogsFeed = document.getElementById('fullLogsFeed');
const drawerOverlay = document.getElementById('drawerOverlay');

const squadModal = document.getElementById('squadModal');
const closeSquadModalBtn = document.getElementById('closeSquadModalBtn');
const modalTeamLogoImg = document.getElementById('modalTeamLogoImg');
const modalTeamName = document.getElementById('modalTeamName');
const modalTeamPurse = document.getElementById('modalTeamPurse');
const modalSquadList = document.getElementById('modalSquadList');
const btnViewFinalSquads = document.getElementById('btnViewFinalSquads');
const toastContainer = document.getElementById('toastContainer');

// Voice Toggle Handler
toggleVoiceBtn.addEventListener('click', () => {
  isVoiceEnabled = !isVoiceEnabled;
  if (isVoiceEnabled) {
    voiceIcon.className = 'fa-solid fa-volume-high';
    toggleVoiceBtn.classList.replace('text-slate-400', 'text-amber-400');
    showToast('Voice Commentary Enabled', 'info');
    speakCommentary('Commentary audio is now active!');
  } else {
    voiceIcon.className = 'fa-solid fa-volume-xmark';
    toggleVoiceBtn.classList.replace('text-amber-400', 'text-slate-400');
    showToast('Voice Commentary Muted', 'info');
  }
});

// View Navigation
function switchView(viewName) {
  viewWelcome.classList.add('hidden');
  viewLobby.classList.add('hidden');
  viewAuction.classList.add('hidden');
  viewFinished.classList.add('hidden');

  if (viewName === 'WELCOME') viewWelcome.classList.remove('hidden');
  if (viewName === 'LOBBY') viewLobby.classList.remove('hidden');
  if (viewName === 'AUCTION') viewAuction.classList.remove('hidden');
  if (viewName === 'FINISHED') viewFinished.classList.remove('hidden');
}

// Toast Notifications
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  const bgClasses = {
    info: 'bg-slate-800 border-slate-700 text-slate-100',
    success: 'bg-emerald-900/90 border-emerald-600 text-emerald-100',
    error: 'bg-rose-900/90 border-rose-600 text-rose-100',
    warning: 'bg-amber-900/90 border-amber-600 text-amber-100'
  };

  toast.className = `p-3.5 rounded-xl border shadow-xl flex items-center justify-between text-xs font-medium backdrop-blur-md transition-all duration-300 pointer-events-auto transform translate-y-2 opacity-0 ${bgClasses[type] || bgClasses.info}`;
  toast.innerHTML = `
    <div class="flex items-center space-x-2">
      <i class="fa-solid ${type === 'error' ? 'fa-circle-xmark' : type === 'success' ? 'fa-circle-check' : 'fa-bell'}"></i>
      <span>${message}</span>
    </div>
  `;

  toastContainer.appendChild(toast);
  setTimeout(() => toast.classList.remove('translate-y-2', 'opacity-0'), 10);
  setTimeout(() => {
    toast.classList.add('opacity-0', 'translate-x-4');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// Tab Switching
btnTabCreate.addEventListener('click', () => {
  btnTabCreate.className = 'py-2.5 rounded-xl font-bold text-xs uppercase transition border bg-amber-500 text-slate-950 border-amber-500';
  btnTabJoin.className = 'py-2.5 rounded-xl font-bold text-xs uppercase transition border bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700';
  formCreateRoom.classList.remove('hidden');
  formJoinRoom.classList.add('hidden');
});

btnTabJoin.addEventListener('click', () => {
  btnTabJoin.className = 'py-2.5 rounded-xl font-bold text-xs uppercase transition border bg-amber-500 text-slate-950 border-amber-500';
  btnTabCreate.className = 'py-2.5 rounded-xl font-bold text-xs uppercase transition border bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700';
  formJoinRoom.classList.remove('hidden');
  formCreateRoom.classList.add('hidden');
});

// Create Room
btnSubmitCreateRoom.addEventListener('click', () => {
  if (!socket) {
    socket = initSocket();
  }

  const origHTML = btnSubmitCreateRoom.innerHTML;
  btnSubmitCreateRoom.disabled = true;
  btnSubmitCreateRoom.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1.5"></i> Launching Room...';

  const timeout = setTimeout(() => {
    btnSubmitCreateRoom.disabled = false;
    btnSubmitCreateRoom.innerHTML = origHTML;
    showToast('Cloud server is still spinning up. Please try again in a moment.', 'warning');
  }, 15000);

  const initialPurse = document.getElementById('selectInitialPurse').value;
  const retentionsAllowed = document.getElementById('selectRetentionsAllowed').value;
  const maxSquadSize = document.getElementById('inputMaxSquad').value;
  const maxOverseas = document.getElementById('inputMaxOverseas').value;

  const performCreate = () => {
    socket.emit('create_room', {
      initialPurse,
      retentionsAllowed,
      maxSquadSize,
      maxOverseas
    }, (res) => {
      clearTimeout(timeout);
      btnSubmitCreateRoom.disabled = false;
      btnSubmitCreateRoom.innerHTML = origHTML;

      if (res && res.success) {
        currentRoom = res.roomState;
        isHost = true;
        setupLobby();
        showToast(`Room created! Code: ${res.roomCode}`, 'success');
      } else {
        showToast(res ? res.error : 'Failed to create room', 'error');
      }
    });
  };

  if (socket && socket.connected) {
    performCreate();
  } else {
    showToast('Connecting to cloud server... Launching room upon connection.', 'info');
    if (!socket) socket = initSocket();
    if (socket) {
      socket.once('connect', performCreate);
    } else {
      clearTimeout(timeout);
      btnSubmitCreateRoom.disabled = false;
      btnSubmitCreateRoom.innerHTML = origHTML;
      showToast('Could not establish connection to cloud server.', 'error');
    }
  }
});

// Join Room
btnSubmitJoinRoom.addEventListener('click', () => {
  const roomCode = inputJoinRoomCode.value.trim().toUpperCase();
  if (!roomCode) return showToast('Please enter room code', 'warning');

  if (!socket) {
    socket = initSocket();
  }

  const origHTML = btnSubmitJoinRoom.innerHTML;
  btnSubmitJoinRoom.disabled = true;
  btnSubmitJoinRoom.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1.5"></i> Entering...';

  const timeout = setTimeout(() => {
    btnSubmitJoinRoom.disabled = false;
    btnSubmitJoinRoom.innerHTML = origHTML;
    showToast('Server response timed out. Please check your room code or connection.', 'warning');
  }, 12000);

  const performJoin = () => {
    socket.emit('join_room', { roomCode }, (res) => {
      clearTimeout(timeout);
      btnSubmitJoinRoom.disabled = false;
      btnSubmitJoinRoom.innerHTML = origHTML;

      if (res && res.success) {
        currentRoom = res.roomState;
        isHost = currentRoom.hostId === socket.id;
        setupLobby();
        showToast(`Joined room [${roomCode}]!`, 'success');
      } else {
        showToast(res ? res.error : 'Room not found', 'error');
      }
    });
  };

  if (socket && socket.connected) {
    performJoin();
  } else {
    showToast('Connecting to cloud server... Entering room upon connection.', 'info');
    if (!socket) socket = initSocket();
    if (socket) {
      socket.once('connect', performJoin);
    } else {
      clearTimeout(timeout);
      btnSubmitJoinRoom.disabled = false;
      btnSubmitJoinRoom.innerHTML = origHTML;
      showToast('Could not establish connection to cloud server.', 'error');
    }
  }
});

// Copy Room Code
btnCopyCode.addEventListener('click', () => {
  if (currentRoom) {
    navigator.clipboard.writeText(currentRoom.code);
    showToast('Room code copied to clipboard!', 'success');
  }
});

// Setup Lobby UI
function setupLobby() {
  switchView('LOBBY');
  roomBadge.classList.remove('hidden');
  currentRoomCode.textContent = currentRoom.code;
  lobbyRoomCode.textContent = currentRoom.code;

  if (isHost) {
    hostNotice.classList.remove('hidden');
    btnStartAuctionHost.classList.remove('hidden');
    btnHostSkipPlayer.classList.remove('hidden');
    btnHostUndoSkipPlayer.classList.remove('hidden');
  } else {
    hostNotice.classList.add('hidden');
    btnStartAuctionHost.classList.add('hidden');
    btnHostSkipPlayer.classList.add('hidden');
    btnHostUndoSkipPlayer.classList.add('hidden');
  }

  renderFranchiseGrid();
  updateDrawerTeams();
  updateLobbyRetentionBanner();
}

// Render Available Franchises with Real Official Logos
function renderFranchiseGrid() {
  franchiseGrid.innerHTML = '';
  const takenMap = new Map();
  (currentRoom.teams || []).forEach(t => takenMap.set(t.franchiseId, t));

  FRANCHISES.forEach(f => {
    const isTaken = takenMap.has(f.id);
    const isMine = myTeam && myTeam.franchiseId === f.id;
    const teamOwner = takenMap.get(f.id);

    const card = document.createElement('div');
    card.className = `p-3 rounded-2xl border flex flex-col items-center justify-between transition-all ${
      isMine
        ? 'border-amber-400 bg-amber-500/10 shadow-lg shadow-amber-500/10 ring-2 ring-amber-400/50'
        : isTaken
        ? 'opacity-40 border-slate-800 bg-slate-900 cursor-not-allowed'
        : 'border-slate-800 bg-slate-900/80 hover:border-slate-600 hover:bg-slate-800/80 cursor-pointer active:scale-95'
    }`;

    card.innerHTML = `
      <div class="w-14 h-14 p-1 mb-1.5 flex items-center justify-center">
        <img src="${f.logo}" alt="${f.name}" class="w-full h-full object-contain filter drop-shadow" />
      </div>
      <div class="font-black text-xs text-center text-white mb-0.5 tracking-wider">${f.id}</div>
      <div class="text-[10px] text-slate-400 text-center truncate w-full mb-2">${f.name}</div>
      ${
        isMine 
          ? `<span class="px-2.5 py-0.5 text-[9px] font-black rounded-full bg-amber-400 text-slate-950 uppercase">YOUR TEAM</span>`
          : isTaken 
          ? `<span class="px-2 py-0.5 text-[9px] font-semibold rounded-full bg-slate-800 text-slate-400 truncate max-w-full">${teamOwner.managerName}</span>`
          : `<span class="px-2.5 py-0.5 text-[9px] font-semibold rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">CLAIM</span>`
      }
    `;

    if (!isTaken) {
      card.addEventListener('click', () => selectFranchise(f.id));
    }

    franchiseGrid.appendChild(card);
  });
}

// Select Franchise & Automatically Pop Open the Retention Window
function selectFranchise(franchiseId) {
  const managerName = inputManagerName.value.trim() || 'Player ' + Math.floor(Math.random() * 90 + 10);
  socket.emit('select_team', { franchiseId, managerName }, (res) => {
    if (res && res.success) {
      myTeam = res.team;
      currentFranchiseRoster = res.franchiseRoster || [];
      mySelectedRetentions = res.team.retentions || [];
      updateUserFranchisePill();
      renderFranchiseGrid();
      updateLobbyRetentionBanner();
      showToast(`Claimed ${myTeam.name}!`, 'success');

      if (currentRoom.settings.retentionsAllowed > 0) {
        openRetentionModal(res.franchiseRoster);
      }
    } else {
      showToast(res ? res.error : 'Failed to select team', 'error');
    }
  });
}

function updateUserFranchisePill() {
  if (!myTeam) return;
  userFranchisePill.classList.remove('hidden');
  userFranchisePill.classList.add('flex');
  userFranchiseLogo.src = myTeam.logo || `/logos/${myTeam.franchiseId}.svg`;
  userFranchiseTag.textContent = myTeam.franchiseId;
  userPurseDisplay.textContent = formatCurrency(myTeam.purse);

  myPurseAmount.textContent = formatCurrency(myTeam.purse);
  mySquadCount.textContent = `${myTeam.squadCount || 0}/${currentRoom.settings.maxSquadSize}`;
  myOverseasCount.textContent = `${myTeam.overseasCount || 0}/${currentRoom.settings.maxOverseas}`;
}

// Update the Persistent Lobby Banner for the User's Franchise
function updateLobbyRetentionBanner() {
  if (!myTeam || !currentRoom) {
    retentionBanner.classList.add('hidden');
    return;
  }

  retentionBanner.classList.remove('hidden');
  bannerTeamLogo.src = myTeam.logo || `/logos/${myTeam.franchiseId}.svg`;
  bannerTeamName.textContent = myTeam.name;
  bannerPurseDisplay.textContent = formatCurrency(myTeam.purse);
  bannerMaxRetentions.textContent = currentRoom.settings.retentionsAllowed;
  bannerRetentionsCountBadge.textContent = `${mySelectedRetentions.length}/${currentRoom.settings.retentionsAllowed} Retained`;

  // Find player names from currentFranchiseRoster
  if (mySelectedRetentions.length > 0) {
    const retainedNames = mySelectedRetentions
      .map(id => {
        const found = currentFranchiseRoster.find(p => p.id === id);
        return found ? found.name : id;
      })
      .join(', ');
    bannerRetainedNames.innerHTML = `<span class="text-emerald-400 font-bold">★ Locked In:</span> <span class="text-white">${retainedNames}</span>`;
  } else {
    bannerRetainedNames.textContent = currentRoom.settings.retentionsAllowed > 0 
      ? 'No players retained yet. Click button to pick your core stars!'
      : 'Retentions are disabled in this auction room.';
  }

  if (currentRoom.settings.retentionsAllowed === 0) {
    btnOpenRetentionModal.classList.add('hidden');
  } else {
    btnOpenRetentionModal.classList.remove('hidden');
  }
}

// OPEN RETENTION MODAL
function openRetentionModal(roster = null) {
  if (!myTeam) return;
  if (roster && Array.isArray(roster) && roster.length > 0) {
    currentFranchiseRoster = roster;
    setupModalUI();
  } else if (!currentFranchiseRoster || currentFranchiseRoster.length === 0) {
    fetch(`${ACTIVE_BACKEND}/api/franchise-players/${myTeam.franchiseId}`)
      .then(r => r.json())
      .then(players => {
        currentFranchiseRoster = players;
        setupModalUI();
      })
      .catch(err => {
        showToast('Could not load franchise roster', 'error');
      });
  } else {
    setupModalUI();
  }
}

function setupModalUI() {
  modalRetentionLogo.src = myTeam.logo || `/logos/${myTeam.franchiseId}.svg`;
  modalRetentionTeamName.textContent = myTeam.name;
  modalMaxRetentions.textContent = currentRoom.settings.retentionsAllowed;
  modalCountAll.textContent = currentFranchiseRoster.length;

  retentionModal.classList.remove('hidden');
  renderModalRetentionGrid();
}

function closeRetentionModal() {
  retentionModal.classList.add('hidden');
}

// Filter and Render Franchise Player Cards in the Modal
function renderModalRetentionGrid() {
  modalRetentionPlayersGrid.innerHTML = '';

  // 1. Calculate live financial summary
  let totalDeduction = 0;
  mySelectedRetentions.forEach((id, idx) => {
    totalDeduction += RETENTION_COSTS[idx] || 100000000;
  });
  const initPurse = currentRoom.settings.initialPurse || 1000000000;
  const remPurse = initPurse - totalDeduction;

  modalInitialPurse.textContent = formatCurrency(initPurse);
  modalDeductionPurse.textContent = totalDeduction > 0 ? `-${formatCurrency(totalDeduction)}` : '₹0.00 Cr';
  modalRemainingPurse.textContent = formatCurrency(remPurse);
  modalSelectedCountBadge.textContent = `Selected: ${mySelectedRetentions.length}/${currentRoom.settings.retentionsAllowed}`;

  // 2. Filter roster
  const query = (currentRetentionSearch || '').toLowerCase().trim();
  const filtered = currentFranchiseRoster.filter(player => {
    const matchesFilter = currentRetentionFilter === 'ALL' || player.role === currentRetentionFilter;
    const matchesQuery = !query || player.name.toLowerCase().includes(query) || player.role.toLowerCase().includes(query);
    return matchesFilter && matchesQuery;
  });

  if (filtered.length === 0) {
    modalRetentionPlayersGrid.innerHTML = `
      <div class="col-span-full py-12 text-center text-slate-400">
        <i class="fa-solid fa-user-slash text-2xl mb-2 text-slate-600 block"></i>
        <div class="font-bold text-sm">No players match "${query || currentRetentionFilter}"</div>
        <div class="text-xs text-slate-500 mt-1">Try another filter or search term.</div>
      </div>
    `;
    return;
  }

  // 3. Render cards
  filtered.forEach(player => {
    const isRetained = mySelectedRetentions.includes(player.id);
    const retentionIndex = mySelectedRetentions.indexOf(player.id);
    const slotCost = retentionIndex >= 0 ? RETENTION_COSTS[retentionIndex] : (RETENTION_COSTS[mySelectedRetentions.length] || 100000000);

    const roleColors = {
      'Batter': 'bg-amber-500/20 text-amber-300 border-amber-500/30',
      'Bowler': 'bg-sky-500/20 text-sky-300 border-sky-500/30',
      'All-Rounder': 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
      'Wicketkeeper': 'bg-purple-500/20 text-purple-300 border-purple-500/30'
    };

    const card = document.createElement('div');
    card.className = `p-3 rounded-2xl border transition-all cursor-pointer flex flex-col justify-between ${
      isRetained 
        ? 'border-amber-400 bg-amber-500/15 shadow-xl shadow-amber-500/10 ring-2 ring-amber-400/50 scale-[1.01]' 
        : 'border-slate-800 bg-slate-900/90 hover:border-slate-700 hover:bg-slate-850'
    }`;

    card.innerHTML = `
      <div class="flex items-start space-x-3 mb-2">
        <div class="relative flex-shrink-0">
          <img 
            src="${player.photo}" 
            alt="${player.name}" 
            class="w-14 h-14 rounded-2xl object-cover object-top border border-slate-700 shadow" 
            onerror="this.src='/icons/player_avatar.svg'"
          />
          ${
            isRetained 
              ? `<span class="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-amber-400 text-slate-950 font-black text-xs flex items-center justify-center shadow">✓</span>`
              : ''
          }
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center space-x-1.5">
            <h4 class="font-extrabold text-xs text-white truncate">${player.name}</h4>
            ${player.isOverseas ? '<span class="text-[9px] px-1 py-0.2 rounded bg-blue-500/30 text-blue-300 font-bold">OS</span>' : ''}
          </div>
          <div class="flex items-center space-x-1 mt-0.5">
            <span class="px-1.5 py-0.5 rounded text-[9px] font-bold border ${roleColors[player.role] || 'bg-slate-800 text-slate-300'}">${player.role}</span>
            <span class="text-[10px] text-slate-400 truncate">• ${player.country}</span>
          </div>
          <div class="text-[10px] text-slate-400 font-mono mt-1">
            ${player.stats.matches} M | ${player.stats.runs || 0} Runs | ${player.stats.wickets || 0} Wkts
          </div>
        </div>
      </div>

      <div class="pt-2 border-t border-slate-800/80 flex items-center justify-between">
        <div class="text-[10px]">
          <span class="text-slate-400">Cost:</span> 
          <b class="text-amber-400 font-mono font-bold">${formatCurrency(slotCost)}</b>
        </div>
        <button class="px-3 py-1 rounded-lg text-[10px] font-black uppercase tracking-wider transition ${
          isRetained 
            ? 'bg-amber-400 text-slate-950 shadow-md' 
            : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700'
        }">
          ${isRetained ? 'RETAINED ✓' : 'RETAIN +'}
        </button>
      </div>
    `;

    card.addEventListener('click', () => {
      toggleRetentionPlayer(player.id);
    });

    modalRetentionPlayersGrid.appendChild(card);
  });
}

function toggleRetentionPlayer(playerId) {
  if (mySelectedRetentions.includes(playerId)) {
    mySelectedRetentions = mySelectedRetentions.filter(id => id !== playerId);
  } else {
    if (mySelectedRetentions.length >= currentRoom.settings.retentionsAllowed) {
      showToast(`Maximum ${currentRoom.settings.retentionsAllowed} retentions allowed by Host`, 'warning');
      return;
    }
    mySelectedRetentions.push(playerId);
  }

  renderModalRetentionGrid();
  updateLobbyRetentionBanner();
}

// Retention Modal Event Listeners
btnOpenRetentionModal.addEventListener('click', () => {
  openRetentionModal();
});

closeRetentionModalBtn.addEventListener('click', () => {
  closeRetentionModal();
});

// Category Filter Buttons
document.querySelectorAll('.retention-filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.retention-filter-btn').forEach(b => {
      b.className = 'retention-filter-btn px-3 py-1 rounded-xl text-xs font-semibold bg-slate-900 text-slate-300 border border-slate-800 hover:bg-slate-800';
    });
    btn.className = 'retention-filter-btn px-3 py-1 rounded-xl text-xs font-black bg-amber-400 text-slate-950 shadow-md';
    currentRetentionFilter = btn.getAttribute('data-filter') || 'ALL';
    renderModalRetentionGrid();
  });
});

// Search input
if (searchRetentionPlayer) {
  searchRetentionPlayer.addEventListener('input', (e) => {
    currentRetentionSearch = e.target.value;
    renderModalRetentionGrid();
  });
}

// Skip Retentions (0 Players)
btnSkipRetentions.addEventListener('click', () => {
  if (mySelectedRetentions.length > 0 && !confirm('Clear all retentions and save 100% of your purse for the auction?')) {
    return;
  }
  mySelectedRetentions = [];
  socket.emit('submit_retentions', { playerIds: [] }, (res) => {
    if (res && res.success) {
      myTeam = res.team;
      updateUserFranchisePill();
      updateLobbyRetentionBanner();
      closeRetentionModal();
      showToast('All retentions cleared. Full purse ready for auction!', 'info');
    }
  });
});

// Save & Lock Retentions in Modal
btnSaveRetentionsModal.addEventListener('click', () => {
  socket.emit('submit_retentions', { playerIds: mySelectedRetentions }, (res) => {
    if (res && res.success) {
      myTeam = res.team;
      updateUserFranchisePill();
      updateLobbyRetentionBanner();
      closeRetentionModal();
      showToast(`Locked in ${mySelectedRetentions.length} retention(s)!`, 'success');
      speakCommentary(`${myTeam.name} confirmed their franchise retentions.`);
    } else {
      showToast(res ? res.error : 'Failed to save retentions', 'error');
    }
  });
});

// Start Auction (Host)
btnStartAuctionHost.addEventListener('click', () => {
  socket.emit('start_auction', {}, (res) => {
    if (res && res.success) {
      showToast('Auction starting!', 'success');
      speakCommentary('The Indian Premier League Mega Auction has officially begun! Ladies and gentlemen, take your seats.');
    } else {
      showToast(res ? res.error : 'Cannot start auction', 'error');
    }
  });
});

// Host Skip Player
btnHostSkipPlayer.addEventListener('click', () => {
  if (!confirm('Pass / skip this player to unsold?')) return;
  socket.emit('skip_player', {}, (res) => {
    if (!res || !res.success) {
      showToast(res ? res.error : 'Failed to skip', 'error');
    }
  });
});

// Host Undo Skip Player
btnHostUndoSkipPlayer.addEventListener('click', () => {
  socket.emit('undo_skip_player', {}, (res) => {
    if (res && res.success) {
      showToast('Restored skipped player to hammer!', 'success');
    } else {
      showToast(res ? res.error : 'Nothing to undo', 'warning');
    }
  });
});

// Update Live Auction View
function updateAuctionView(room) {
  switchView('AUCTION');
  const player = room.currentPlayer;
  if (!player) return;

  playerSoldWatermark.classList.add('hidden');
  playerUnsoldWatermark.classList.add('hidden');

  playerName.textContent = player.name;
  playerBatBowlStyle.textContent = `${player.stats.battingStyle || 'Right hand Bat'} • ${player.stats.bowlingStyle || 'Right arm Medium'}`;
  playerRoleBadge.textContent = player.role;
  playerCountryBadge.textContent = player.isOverseas ? `✈️ ${player.country}` : `🇮🇳 ${player.country}`;
  playerTierBadge.textContent = `${player.tier} (${room.auctionIndex + 1}/${room.totalPlayers})`;
  playerOriginalTeam.textContent = player.originalTeam || 'None';
  playerBasePrice.textContent = formatCurrency(player.basePrice);

  playerImage.src = player.photo;

  // Real stats
  stat1.textContent = player.stats.matches || 0;
  if (player.role === 'Bowler') {
    statLabel2.textContent = 'Wickets';
    stat2.textContent = player.stats.wickets || 0;
    statLabel3.textContent = 'Economy';
    stat3.textContent = player.stats.economy || '-';
    statLabel4.textContent = 'Best';
    stat4.textContent = player.stats.bestBowling || '-';
  } else {
    statLabel2.textContent = 'Runs';
    stat2.textContent = player.stats.runs || 0;
    statLabel3.textContent = 'Average';
    stat3.textContent = player.stats.average || '-';
    statLabel4.textContent = 'Strike Rate';
    stat4.textContent = player.stats.strikeRate || '-';
  }

  // Current Bid
  currentBidAmount.textContent = formatCurrency(room.currentBid);

  // Highest bidder
  if (room.highestBidder) {
    highestBidderName.textContent = `${room.highestBidder.teamName} (${room.highestBidder.teamId}) - ${room.highestBidder.managerName}`;
    highestBidderPlaceholderIcon.classList.add('hidden');
    highestBidderLogoImg.classList.remove('hidden');
    highestBidderLogoImg.src = room.highestBidder.logo || `/logos/${room.highestBidder.teamId}.svg`;
    highestBidderBadge.style.backgroundColor = room.highestBidder.color || '#334155';
  } else {
    highestBidderName.textContent = 'Waiting for opening bid (Hammer idle)';
    highestBidderPlaceholderIcon.classList.remove('hidden');
    highestBidderLogoImg.classList.add('hidden');
    highestBidderBadge.style.backgroundColor = '#1E293B';
  }

  // Timer idle state if not started yet
  if (!room.isTimerRunning) {
    auctionTimer.textContent = '--';
    auctionTimer.classList.remove('text-rose-500', 'animate-ping');
    auctionTimer.classList.add('text-slate-400');
  }

  // Host Undo Skip visibility
  if (isHost && room.canUndoSkip) {
    btnHostUndoSkipPlayer.classList.remove('hidden');
    btnHostUndoSkipPlayer.classList.add('flex');
  } else {
    btnHostUndoSkipPlayer.classList.add('hidden');
  }

  updateBidButton();
}

// Update BID button labels and pre-checks
function updateBidButton() {
  if (!currentRoom || !currentRoom.currentPlayer) return;

  const currentBid = currentRoom.currentBid;
  let nextAmount;
  let inc;

  if (!currentRoom.highestBidder) {
    nextAmount = currentRoom.currentPlayer.basePrice;
    inc = 0;
    bidButtonText.textContent = `BID (Base ${formatCurrency(nextAmount)})`;
  } else {
    inc = calculateIncrement(currentBid);
    nextAmount = currentBid + inc;
    bidButtonText.textContent = `BID (+ ${formatCurrency(inc)}) ➔ ${formatCurrency(nextAmount)}`;
  }

  bidStatusNotice.classList.add('hidden');
  btnPlaceBid.disabled = false;

  if (!myTeam) {
    btnPlaceBid.disabled = true;
    bidStatusNotice.textContent = 'Select a team first to place bids';
    bidStatusNotice.classList.remove('hidden');
    return;
  }

  if (currentRoom.highestBidder && currentRoom.highestBidder.socketId === socket.id) {
    btnPlaceBid.disabled = true;
    bidStatusNotice.textContent = 'You are already the highest bidder!';
    bidStatusNotice.classList.remove('hidden');
    return;
  }

  if (myTeam.purse < nextAmount) {
    btnPlaceBid.disabled = true;
    bidStatusNotice.textContent = `Insufficient purse! Needed ${formatCurrency(nextAmount)}`;
    bidStatusNotice.classList.remove('hidden');
    return;
  }

  if (myTeam.squadCount >= currentRoom.settings.maxSquadSize) {
    btnPlaceBid.disabled = true;
    bidStatusNotice.textContent = `Squad full (${currentRoom.settings.maxSquadSize} players)`;
    bidStatusNotice.classList.remove('hidden');
    return;
  }

  if (currentRoom.currentPlayer.isOverseas && myTeam.overseasCount >= currentRoom.settings.maxOverseas) {
    btnPlaceBid.disabled = true;
    bidStatusNotice.textContent = `Overseas slots full (${currentRoom.settings.maxOverseas} max)`;
    bidStatusNotice.classList.remove('hidden');
    return;
  }

  if (isBidCooldown) {
    btnPlaceBid.disabled = true;
  }

  // Update Fold button state
  if (!myTeam || !currentRoom || !currentRoom.currentPlayer) {
    btnFoldPlayer.disabled = true;
  } else if (currentRoom.highestBidder && (currentRoom.highestBidder.socketId === socket.id || currentRoom.highestBidder.teamId === myTeam.franchiseId)) {
    btnFoldPlayer.disabled = true;
    foldButtonText.textContent = 'LEADING';
    btnFoldPlayer.classList.add('opacity-40');
    btnFoldPlayer.classList.remove('border-emerald-500/50', 'text-emerald-400');
  } else {
    const foldedList = currentRoom.foldedTeams || [];
    const hasFolded = foldedList.includes(myTeam.franchiseId);
    if (hasFolded) {
      btnFoldPlayer.disabled = true;
      foldButtonText.textContent = 'FOLDED ✓';
      btnFoldPlayer.classList.remove('opacity-40');
      btnFoldPlayer.classList.add('border-emerald-500/50', 'text-emerald-400');
    } else {
      btnFoldPlayer.disabled = false;
      foldButtonText.textContent = 'FOLD';
      btnFoldPlayer.classList.remove('opacity-40', 'border-emerald-500/50', 'text-emerald-400');
    }
  }

  // Update consensus fold status bar
  const foldedCount = currentRoom.foldedCount || 0;
  const requiredFolds = currentRoom.requiredFolds || (currentRoom.teams ? Math.max(currentRoom.teams.length - 1, 1) : 1);
  foldCountDisplay.textContent = `${foldedCount}/${requiredFolds} Teams`;
  if (foldedCount > 0 && foldedCount < requiredFolds) {
    foldStatusHint.textContent = `${requiredFolds - foldedCount} more needed for instant hammer`;
  } else if (foldedCount >= requiredFolds && requiredFolds > 0) {
    foldStatusHint.textContent = `All teams folded! Hammer falling...`;
  } else {
    foldStatusHint.textContent = `Instant sell if all pass`;
  }
}

// FOLD BUTTON CLICK HANDLER
btnFoldPlayer.addEventListener('click', () => {
  if (!currentRoom || !currentRoom.currentPlayer || !myTeam) return;

  socket.emit('team_fold', {}, (res) => {
    if (res && res.success) {
      playBeep(320, 'sine', 0.15);
      showToast('You folded on this player!', 'info');
      foldButtonText.textContent = 'FOLDED ✓';
      btnFoldPlayer.disabled = true;
    } else {
      showToast(res ? res.error : 'Cannot fold right now', 'warning');
    }
  });
});

// BID BUTTON CLICK HANDLER
btnPlaceBid.addEventListener('click', () => {
  if (isBidCooldown || !currentRoom || !currentRoom.currentPlayer) return;

  const expectedCurrentBid = currentRoom.currentBid;

  isBidCooldown = true;
  btnPlaceBid.disabled = true;
  setTimeout(() => {
    isBidCooldown = false;
    updateBidButton();
  }, 500);

  socket.emit('place_bid', { expectedCurrentBid }, (res) => {
    if (res && res.success) {
      playBidSound();
    } else {
      playBeep(200, 'sawtooth', 0.25);
      showToast(res ? res.error : 'Bid was rejected', 'error');
      if (res && res.serverCurrentBid !== undefined) {
        currentRoom.currentBid = res.serverCurrentBid;
        currentBidAmount.textContent = formatCurrency(res.serverCurrentBid);
      }
      updateBidButton();
    }
  });
});

// Update Sidebar Teams Dashboard
function updateDrawerTeams() {
  if (!currentRoom) return;
  drawerTeamsList.innerHTML = '';
  const teams = currentRoom.teams || [];
  teamsCountBadge.textContent = teams.length;

  teams.forEach(team => {
    const isMe = myTeam && myTeam.franchiseId === team.franchiseId;
    const card = document.createElement('div');
    card.className = `p-3 rounded-2xl border flex flex-col justify-between transition cursor-pointer hover:border-slate-600 ${
      isMe ? 'border-amber-400/80 bg-amber-500/10' : 'border-slate-800 bg-slate-950/70'
    }`;

    card.innerHTML = `
      <div class="flex items-center justify-between mb-1.5">
        <div class="flex items-center space-x-2.5">
          <img src="${team.logo || `/logos/${team.franchiseId}.svg`}" alt="${team.franchiseId}" class="w-8 h-8 object-contain" />
          <div>
            <div class="text-xs font-black text-white flex items-center space-x-1">
              <span>${team.name}</span>
              ${isMe ? '<span class="text-[9px] px-1 bg-amber-400 text-slate-950 font-black rounded">YOU</span>' : ''}
            </div>
            <div class="text-[10px] text-slate-400">${team.managerName}</div>
          </div>
        </div>
        <div class="text-right">
          <div class="text-xs font-bold font-mono text-emerald-400">${formatCurrency(team.purse)}</div>
          <div class="text-[10px] text-slate-400">Purse Left</div>
        </div>
      </div>
      <div class="flex items-center justify-between text-[10px] pt-1.5 border-t border-slate-800/80 text-slate-400">
        <span>Squad: <b class="text-white">${team.squadCount || 0}/${currentRoom.settings.maxSquadSize}</b></span>
        <span>Overseas: <b class="text-blue-400">${team.overseasCount || 0}/${currentRoom.settings.maxOverseas}</b></span>
        <span class="text-amber-400 hover:underline">Inspect ➔</span>
      </div>
    `;

    card.addEventListener('click', () => openSquadModal(team));
    drawerTeamsList.appendChild(card);
  });
}

// Squad Details Modal
function openSquadModal(team) {
  modalTeamLogoImg.src = team.logo || `/logos/${team.franchiseId}.svg`;
  modalTeamName.textContent = team.name;
  modalTeamPurse.textContent = `Remaining Purse: ${formatCurrency(team.purse)} | Squad: ${team.squad.length}/${currentRoom.settings.maxSquadSize}`;

  modalSquadList.innerHTML = '';
  if (team.squad.length === 0) {
    modalSquadList.innerHTML = '<div class="text-center py-6 text-xs text-slate-500">No players acquired yet.</div>';
  } else {
    team.squad.forEach((player, i) => {
      const row = document.createElement('div');
      row.className = 'p-2.5 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-between text-xs';
      row.innerHTML = `
        <div class="flex items-center space-x-2.5">
          <span class="text-slate-500 font-mono font-bold w-4">${i + 1}.</span>
          <img src="${player.photo}" alt="${player.name}" class="w-8 h-8 rounded-lg object-cover border border-slate-700" onerror="this.src='/icons/player_avatar.svg'" />
          <div>
            <div class="font-bold text-white flex items-center space-x-1.5">
              <span>${player.name}</span>
              ${player.isOverseas ? '<span class="text-[9px] px-1 rounded bg-blue-500/20 text-blue-300">OS</span>' : ''}
              ${player.acquiredVia === 'RETENTION' ? '<span class="text-[9px] px-1 rounded bg-amber-500/20 text-amber-300">RETAINED</span>' : ''}
            </div>
            <div class="text-[10px] text-slate-400">${player.role} • ${player.country}</div>
          </div>
        </div>
        <div class="font-mono font-bold text-amber-400 text-right">
          ${formatCurrency(player.finalPrice)}
        </div>
      `;
      modalSquadList.appendChild(row);
    });
  }

  squadModal.classList.remove('hidden');
}

closeSquadModalBtn.addEventListener('click', () => squadModal.classList.add('hidden'));

// Drawers Toggle
function openTeamsDrawer() {
  teamsDrawer.classList.remove('translate-x-full', 'pointer-events-none');
  drawerOverlay.classList.remove('hidden');
}
function closeTeamsDrawer() {
  teamsDrawer.classList.add('translate-x-full', 'pointer-events-none');
  drawerOverlay.classList.add('hidden');
}
function openLogsDrawer() {
  logsDrawer.classList.remove('translate-x-full', 'pointer-events-none');
  drawerOverlay.classList.remove('hidden');
}
function closeLogsDrawer() {
  logsDrawer.classList.add('translate-x-full', 'pointer-events-none');
  drawerOverlay.classList.add('hidden');
}

toggleDrawerBtn.addEventListener('click', () => {
  if (teamsDrawer.classList.contains('translate-x-full')) {
    openTeamsDrawer();
  } else {
    closeTeamsDrawer();
  }
});
closeTeamsDrawerBtn.addEventListener('click', closeTeamsDrawer);

toggleLogsBtn.addEventListener('click', () => {
  if (logsDrawer.classList.contains('translate-x-full')) {
    openLogsDrawer();
  } else {
    closeLogsDrawer();
  }
});
closeLogsDrawerBtn.addEventListener('click', closeLogsDrawer);

drawerOverlay.addEventListener('click', () => {
  closeTeamsDrawer();
  closeLogsDrawer();
});

btnViewFinalSquads.addEventListener('click', openTeamsDrawer);

// Logs feed update
function renderLogEntry(entry) {
  const row = document.createElement('div');
  const typeColors = {
    sold: 'text-emerald-400 border-l-2 border-emerald-500 pl-2',
    unsold: 'text-rose-400 border-l-2 border-rose-500 pl-2',
    bid: 'text-amber-300',
    announcement: 'text-cyan-300 font-bold',
    warning: 'text-rose-300 font-bold',
    finish: 'text-yellow-400 font-bold'
  };

  row.className = `py-1 ${typeColors[entry.type] || 'text-slate-300'}`;
  row.innerHTML = `<span class="text-slate-500">[${entry.time}]</span> ${entry.message}`;

  fullLogsFeed.prepend(row);
  liveFeedTicker.textContent = entry.message;
}

// SOCKET.IO REAL-TIME LISTENERS
function registerSocketAuctionListeners(s) {
  if (!s) return;

  s.on('room_update', (roomState) => {
    currentRoom = roomState;
    isHost = currentRoom.hostId === s.id;

    if (myTeam) {
      const fresh = roomState.teams.find(t => t.socketId === s.id || t.franchiseId === myTeam.franchiseId);
      if (fresh) {
        myTeam = fresh;
        if (Array.isArray(fresh.retentions) && fresh.retentions.length > 0) {
          mySelectedRetentions = fresh.retentions;
        }
        updateUserFranchisePill();
        updateLobbyRetentionBanner();
      }
    }

    updateDrawerTeams();

    if (roomState.status === 'LOBBY' || roomState.status === 'RETENTION') {
      setupLobby();
    } else if (roomState.status === 'AUCTION') {
      updateAuctionView(roomState);
    } else if (roomState.status === 'FINISHED') {
      switchView('FINISHED');
    }
  });

  s.on('timer_tick', ({ seconds, isRunning }) => {
    if (isRunning) {
      auctionTimer.textContent = seconds;
      if (seconds <= 3) {
        auctionTimer.classList.add('text-rose-500', 'animate-ping');
        playBeep(880, 'square', 0.08);
        if (seconds === 3) speakCommentary('Going once!');
        else if (seconds === 2) speakCommentary('Going twice!');
        else if (seconds === 1) speakCommentary('Final call!');
      } else {
        auctionTimer.classList.remove('text-rose-500', 'animate-ping', 'text-slate-400');
        auctionTimer.classList.add('text-amber-400');
      }
    } else {
      auctionTimer.textContent = '--';
      auctionTimer.classList.remove('text-rose-500', 'animate-ping', 'text-amber-400');
      auctionTimer.classList.add('text-slate-400');
    }
  });

  s.on('bid_accepted', ({ currentBid, highestBidder }) => {
    if (currentRoom) {
      currentRoom.currentBid = currentBid;
      currentRoom.highestBidder = highestBidder;
      currentRoom.isTimerRunning = true;
    }
    currentBidAmount.textContent = formatCurrency(currentBid);
    currentBidAmount.classList.add('animate-bid-pulse');
    setTimeout(() => currentBidAmount.classList.remove('animate-bid-pulse'), 300);

    if (highestBidder) {
      highestBidderName.textContent = `${highestBidder.teamName} (${highestBidder.teamId}) - ${highestBidder.managerName}`;
      highestBidderPlaceholderIcon.classList.add('hidden');
      highestBidderLogoImg.classList.remove('hidden');
      highestBidderLogoImg.src = highestBidder.logo || `/logos/${highestBidder.teamId}.svg`;
      highestBidderBadge.style.backgroundColor = highestBidder.color || '#334155';
    }

    playBidSound();
    updateBidButton();

    // Commentary voice on major or new bids
    const priceText = (currentBid / 10000000).toFixed(2);
    speakCommentary(`${highestBidder.teamId} raises the bid to ${priceText} Crores!`);
  });

  s.on('player_sold', ({ player, team, price }) => {
    playHammerSound();
    playerSoldWatermark.classList.remove('hidden');

    const priceText = (price / 10000000).toFixed(2);
    speakCommentary(`Sold! ${player.name} is sold to ${team.name} for ${priceText} Crores!`);

    if (myTeam && myTeam.franchiseId === team.franchiseId && typeof confetti === 'function') {
      confetti({ particleCount: 120, spread: 80, origin: { y: 0.6 } });
    }

    showToast(`🔨 SOLD! ${player.name} to ${team.franchiseId} for ${formatCurrency(price)}!`, 'success');
  });

  s.on('player_unsold', ({ player }) => {
    playHammerSound();
    playerUnsoldWatermark.classList.remove('hidden');
    speakCommentary(`No bids received. ${player.name} goes unsold.`);
    showToast(`❌ ${player.name} went UNSOLD!`, 'warning');
  });

  s.on('all_teams_folded', ({ player, highestBidder }) => {
    playHammerSound();
    if (highestBidder) {
      speakCommentary(`All remaining teams have folded! ${player.name} is sold early to ${highestBidder.teamName}!`);
      showToast(`⚡ All teams folded! Hammer falls early on ${player.name}!`, 'info');
    } else {
      speakCommentary(`All teams have folded without any bids. ${player.name} goes unsold.`);
      showToast(`⚡ All teams folded! ${player.name} passed unsold!`, 'warning');
    }
  });

  s.on('new_log', (entry) => {
    renderLogEntry(entry);
  });
}

// Ensure listeners are bound if socket is already present
if (socket) {
  registerSocketAuctionListeners(socket);
}
