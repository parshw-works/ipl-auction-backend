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
      attemptSessionReentry();
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

// Application State (Declared before any timer or event listener)
let currentRoom = null;
let myTeam = null;
let isHost = false;
let mySelectedRetentions = [];
let currentFranchiseRoster = [];
let currentRetentionFilter = 'ALL';
let currentRetentionSearch = '';
const RETENTION_COSTS = [180000000, 140000000, 110000000, 180000000, 140000000];
let isBidCooldown = false;

// =========================================================================
// GLOBAL AUDIO & SPEECH ENGINE SINGLETON (localStorage persisted)
// =========================================================================
window.auctionAudio = {
  voiceEnabled: (function() {
    try {
      const stored = localStorage.getItem('auction_voice_enabled');
      return stored !== null ? stored === 'true' : true;
    } catch (e) {
      return true;
    }
  })(),
  sfxEnabled: true,

  toggleVoice() {
    this.voiceEnabled = !this.voiceEnabled;
    try {
      localStorage.setItem('auction_voice_enabled', this.voiceEnabled.toString());
    } catch (e) {}
    if (!this.voiceEnabled && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    this.syncUI();
    return this.voiceEnabled;
  },

  syncUI() {
    const btns = document.querySelectorAll('#toggleVoiceBtn, #btn-voice-toggle');
    btns.forEach(btn => {
      const icon = btn.querySelector('i') || btn.querySelector('#voiceIcon');
      const text = btn.querySelector('span') || btn.querySelector('#voiceText');
      if (this.voiceEnabled) {
        if (icon) icon.className = 'fa-solid fa-volume-high text-xs';
        if (text) text.textContent = 'Voice ON';
        btn.classList.remove('text-slate-500', 'border-white/5');
        btn.classList.add('text-amber-400', 'border-white/10');
      } else {
        if (icon) icon.className = 'fa-solid fa-volume-xmark text-xs';
        if (text) text.textContent = 'Voice MUTED';
        btn.classList.remove('text-amber-400', 'border-white/10');
        btn.classList.add('text-slate-500', 'border-white/5');
      }
    });
  }
};

// Global User Settings Singleton (localStorage persisted)
window.userSettings = {
  showCheers: (function() {
    try {
      const stored = localStorage.getItem('auction_show_cheers');
      return stored !== null ? stored === 'true' : true;
    } catch (e) {
      return true;
    }
  })(),

  toggleCheers() {
    this.showCheers = !this.showCheers;
    try {
      localStorage.setItem('auction_show_cheers', this.showCheers.toString());
    } catch (e) {}
    this.syncUI();
    return this.showCheers;
  },

  syncUI() {
    const btns = document.querySelectorAll('#btnCheerToggle');
    btns.forEach(btn => {
      const icon = btn.querySelector('#cheerToggleIcon') || btn.querySelector('i');
      const text = btn.querySelector('#cheerToggleText') || btn.querySelector('span');
      if (this.showCheers) {
        if (icon) icon.className = 'fa-solid fa-bullhorn text-xs';
        if (text) text.textContent = 'Cheers: ON';
        btn.classList.remove('text-slate-500');
        btn.classList.add('text-laserCyan');
      } else {
        if (icon) icon.className = 'fa-solid fa-bell-slash text-xs';
        if (text) text.textContent = 'Cheers: OFF';
        btn.classList.remove('text-laserCyan');
        btn.classList.add('text-slate-500');
      }
    });
  }
};

// UI Helper: Sync Sound Effects Status across all headers & modals
function syncSFXUI() {
  const isEnabled = !!(window.auctionAudio && window.auctionAudio.sfxEnabled);
  document.querySelectorAll('#sfxToggleText').forEach(txt => {
    txt.textContent = isEnabled ? 'ON' : 'OFF';
    txt.className = isEnabled 
      ? 'text-[10px] font-mono text-emerald-400 font-bold' 
      : 'text-[10px] font-mono text-slate-500 font-bold';
  });
}

// UI Helper: Open Settings Modal cleanly across Mobile & PC
function openSettingsModal() {
  const modalSettings = document.getElementById('modal-settings');
  if (modalSettings) {
    modalSettings.classList.remove('hidden');
    modalSettings.style.display = 'flex';
    if (window.auctionAudio && window.auctionAudio.syncUI) window.auctionAudio.syncUI();
    if (window.userSettings && window.userSettings.syncUI) window.userSettings.syncUI();
    syncSFXUI();
  }
}

// UI Helper: Close Settings Modal
function closeSettingsModal() {
  const modalSettings = document.getElementById('modal-settings');
  if (modalSettings) {
    modalSettings.classList.add('hidden');
    modalSettings.style.display = 'none';
  }
}

// UI Helper: Open Standings on Mobile Bottom-Sheet or Desktop Drawer/Modal
function openStandingsUI() {
  if (window.innerWidth <= 768) {
    openMobileBottomSheet();
  } else {
    const modalStandings = document.getElementById('modal-standings');
    if (modalStandings) {
      modalStandings.classList.remove('hidden');
      modalStandings.style.display = 'flex';
      populateModalStandings();
    } else {
      openTeamsDrawer();
    }
  }
}

// Global Click Delegation on Document for Voice, Cheer, Settings & Copy
document.addEventListener('click', (e) => {
  const voiceTarget = e.target.closest('#toggleVoiceBtn, #btn-voice-toggle');
  if (voiceTarget) {
    e.preventDefault();
    const enabled = window.auctionAudio.toggleVoice();
    showToast(enabled ? 'Voice Commentator unmuted 🔊' : 'Voice Commentator muted 🔇', 'info');
    return;
  }

  const cheerTarget = e.target.closest('#btnCheerToggle');
  if (cheerTarget) {
    e.preventDefault();
    const enabled = window.userSettings.toggleCheers();
    showToast(enabled ? 'Cheer FX visible 📣' : 'Cheer FX hidden 🔕', 'info');
    return;
  }

  // Settings Modal Trigger (Lobby Gear, Auction HUD Gear, or any .btn-settings-trigger)
  const menuTrigger = e.target.closest('#btn-open-menu, #btn-open-menu-desktop, .btn-settings-trigger, #btnSettingsMenu');
  if (menuTrigger) {
    e.preventDefault();
    e.stopPropagation();
    openSettingsModal();
    return;
  }

  // Standings Trigger (Auction Top Bar 🏆 Standings button or Lobby Standings button)
  if (e.target.closest('#btn-open-standings, #btn-open-standings-desktop, #toggleDrawerBtn')) {
    e.preventDefault();
    e.stopPropagation();
    openStandingsUI();
    return;
  }

  // SFX Toggle
  const sfxBtn = e.target.closest('#btnToggleSFX');
  if (sfxBtn) {
    e.preventDefault();
    window.auctionAudio.sfxEnabled = !window.auctionAudio.sfxEnabled;
    try {
      localStorage.setItem('auction_sfx_enabled', window.auctionAudio.sfxEnabled.toString());
    } catch (err) {}
    syncSFXUI();
    showToast(window.auctionAudio.sfxEnabled ? 'Sound Effects enabled 🔔' : 'Sound Effects muted 🔕', 'info');
    return;
  }

  // Open Event Feed from Settings Modal
  if (e.target.closest('#btnModalOpenLogs')) {
    e.preventDefault();
    closeSettingsModal();
    openLogsDrawer();
    return;
  }

  // Leave Room (from Header or Settings Modal)
  const leaveBtn = e.target.closest('#btnLeaveRoomHeader, #btnLeaveRoomModal');
  if (leaveBtn) {
    e.preventDefault();
    closeSettingsModal();
    const dropdown = document.getElementById('settingsDropdown');
    if (dropdown) dropdown.classList.add('hidden');
    if (currentViewState === 'auction') {
      openConfirmExitModal(() => {
        if (currentRoom) removeActiveSession(currentRoom.code);
        performSessionCleanupBeforeNewMatch();
        navigate('home', null, true);
        showToast('Left match. Returned to Home.', 'info');
      });
      return;
    }
    if (confirm('Leave current room and return to Home Gateway?')) {
      if (currentRoom) removeActiveSession(currentRoom.code);
      performSessionCleanupBeforeNewMatch();
      navigate('home', null, true);
      showToast('Left match. Returned to Home.', 'info');
    }
    return;
  }

  // Confirm Exit Auction Modal: Stay Action
  const stayAuctionBtn = e.target.closest('#btn-confirm-stay-auction');
  if (stayAuctionBtn) {
    e.preventDefault();
    closeConfirmExitModal();
    showToast('Staying in live auction 🛡️', 'info');
    return;
  }

  // Confirm Exit Auction Modal: Leave Action
  const leaveAuctionBtn = e.target.closest('#btn-confirm-leave-auction');
  if (leaveAuctionBtn) {
    e.preventDefault();
    const action = pendingExitCallback;
    closeConfirmExitModal();
    if (action) {
      action();
    } else {
      if (currentRoom) removeActiveSession(currentRoom.code);
      performSessionCleanupBeforeNewMatch();
      navigate('home', null, true);
      showToast('Left match. Returned to Home.', 'info');
    }
    return;
  }

  // Click on user franchise pill in header opens quick squad modal (EA FC + Legacy)
  const pillTarget = e.target.closest('#userFranchisePill, #btn-header-roster, #btn-header-roster-desktop');
  if (pillTarget && myTeam) {
    e.preventDefault();
    openSquadModal(myTeam);
    return;
  }

  // Click on room badge copies code (EA FC + Legacy)
  const roomBadgeTarget = e.target.closest('#roomBadge, #btn-copy-code, #btn-copy-code-desktop');
  if (roomBadgeTarget && currentRoom && currentRoom.code) {
    navigator.clipboard.writeText(currentRoom.code).then(() => {
      showToast(`Room code [${currentRoom.code}] copied to clipboard! 📋`, 'success');
    }).catch(() => {
      showToast(`Room code: ${currentRoom.code}`, 'info');
    });
    return;
  }

  // Close Any Modal via Close Button or Backdrop Click
  if (e.target.closest('.btn-modal-close') || e.target.classList.contains('modal-backdrop')) {
    document.querySelectorAll('.modal-backdrop').forEach(m => {
      m.classList.add('hidden');
      m.style.display = 'none';
      m.classList.remove('flex');
    });
    return;
  }
});

// Confirmation Popup Helper for Live Auction Exit
let pendingExitCallback = null;

function openConfirmExitModal(onConfirm) {
  pendingExitCallback = onConfirm;
  const modal = document.getElementById('modal-confirm-exit');
  if (modal) {
    modal.classList.remove('hidden');
    modal.style.display = 'flex';
    modal.classList.add('flex');
  }
}

function closeConfirmExitModal() {
  pendingExitCallback = null;
  const modal = document.getElementById('modal-confirm-exit');
  if (modal) {
    modal.classList.add('hidden');
    modal.style.display = 'none';
    modal.classList.remove('flex');
  }
}

// Sync initial UI state after DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  window.auctionAudio.syncUI();
  window.userSettings.syncUI();
  syncSFXUI();
});
setTimeout(() => {
  window.auctionAudio.syncUI();
  window.userSettings.syncUI();
  syncSFXUI();
}, 200);

// Backward compatibility accessor
let isVoiceEnabled = window.auctionAudio.voiceEnabled;

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
      console.log('[IPL] 5 minutes idle — disconnecting socket to let cloud server sleep.');
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

// Web Speech API Voice Commentary Synthesizer
function speakCommentary(text) {
  if (!window.auctionAudio || !window.auctionAudio.voiceEnabled || !('speechSynthesis' in window)) return;
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
  if (window.auctionAudio && !window.auctionAudio.sfxEnabled) return;
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
const btnSubmitJoinSpectator = document.getElementById('btnSubmitJoinSpectator');
const inputJoinRoomCode = document.getElementById('inputJoinRoomCode');
const btnSwitchToSpectatorLobby = document.getElementById('btnSwitchToSpectatorLobby');
const btnToggleSpectatorAuction = document.getElementById('btnToggleSpectatorAuction');
const btnToggleSpectatorDesktop = document.getElementById('btnToggleSpectatorDesktop');
const btnToggleSpectatorModal = document.getElementById('btnToggleSpectatorModal');

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
// Player Card (EA FC Trading Card HUD + Legacy fallbacks)
const playerName = document.getElementById('player-name') || document.getElementById('playerName');
const playerBatBowlStyle = document.getElementById('playerBatBowlStyle');
const playerImage = document.getElementById('player-img') || document.getElementById('playerImage');
const playerRoleBadge = document.getElementById('player-role-tag') || document.getElementById('playerRoleBadge');
const playerCountryBadge = document.getElementById('player-country') || document.getElementById('playerCountryBadge');
const playerTierBadge = document.getElementById('player-lot-tag') || document.getElementById('playerTierBadge');
const playerOriginalTeam = document.getElementById('playerOriginalTeam');
const playerBasePrice = document.getElementById('player-base-price') || document.getElementById('playerBasePrice');
const playerRatingScore = document.getElementById('player-ovr') || document.getElementById('playerRatingScore');
const auctionTimer = document.getElementById('timer-seconds') || document.getElementById('auctionTimer');
const playerSoldWatermark = document.getElementById('playerSoldWatermark');
const playerUnsoldWatermark = document.getElementById('playerUnsoldWatermark');

const stat1 = document.getElementById('stat-col1') || document.getElementById('stat-mat') || document.getElementById('stat1');
const stat2 = document.getElementById('stat-col2') || document.getElementById('stat-runs') || document.getElementById('stat2');
const stat3 = document.getElementById('stat-col3') || document.getElementById('stat-avg') || document.getElementById('stat3');
const stat4 = document.getElementById('stat-col4') || document.getElementById('stat-sr') || document.getElementById('stat4');
const statLabel2 = document.getElementById('stat-col2-label') || document.getElementById('stat-label-2') || document.getElementById('statLabel2');
const statLabel3 = document.getElementById('stat-col3-label') || document.getElementById('stat-label-3') || document.getElementById('statLabel3');
const statLabel4 = document.getElementById('stat-col4-label') || document.getElementById('stat-label-4') || document.getElementById('statLabel4');
const playerOriginTeam = document.getElementById('player-origin-team') || document.getElementById('playerOriginalTeam');

const currentBidAmount = document.getElementById('current-bid-amount') || document.getElementById('currentBidAmount');
const highestBidderName = document.getElementById('leading-bidder-name') || document.getElementById('highestBidderName');
const highestBidderBadge = document.getElementById('highestBidderBadge');
const highestBidderLogoImg = document.getElementById('highestBidderLogoImg');
const highestBidderPlaceholderIcon = document.getElementById('highestBidderPlaceholderIcon');

// Action Area
const btnPlaceBid = document.getElementById('btn-place-bid') || document.getElementById('btnPlaceBid');
const bidButtonText = document.getElementById('bid-btn-text') || document.getElementById('bidButtonText');
const btnFoldPlayer = document.getElementById('btn-fold') || document.getElementById('btnFoldPlayer');
const foldButtonText = document.getElementById('fold-btn-text') || document.getElementById('foldButtonText');
const foldStatusBar = document.getElementById('foldStatusBar');
const foldCountDisplay = document.getElementById('footer-folds') || document.getElementById('foldCountDisplay');
const foldStatusHint = document.getElementById('foldStatusHint');
const bidStatusNotice = document.getElementById('bidStatusNotice');
const myPurseAmount = document.getElementById('footer-purse') || document.getElementById('myPurseAmount');

// Active Lot Bid History for Desktop Broadcast Suite (Reference 4)
let activeLotBidHistory = [];
let lastLotPlayerId = null;

function renderRecentBidsFeed() {
  const container = document.getElementById('recentBidsList');
  if (!container) return;
  if (!activeLotBidHistory || activeLotBidHistory.length === 0) {
    container.innerHTML = '<div class="text-slate-500 text-xs italic py-4 text-center">Waiting for first bid...</div>';
    return;
  }
  container.innerHTML = activeLotBidHistory.map(b => `
    <div class="bid-timeline-entry flex items-center justify-between text-xs py-1 text-slate-200">
      <div class="flex items-center gap-2 truncate pr-2">
        <span class="font-bold text-amber-400 font-mono">${b.teamId}</span>
        <span class="text-slate-400 text-[11px]">raised to</span>
        <span class="font-mono text-white font-bold">${formatCurrency(b.amount)}</span>
      </div>
      <span class="font-mono text-emerald-400 font-black shrink-0">${formatCurrency(b.amount)}</span>
    </div>
  `).join('');
}

// Robust Player Image Fallback Pipeline
window.handlePlayerImageError = function(imgElement, role) {
  imgElement.onerror = null;
  const cleanRole = (role || 'batter').toLowerCase().replace(/[^a-z0-9]/g, '_');
  imgElement.src = `/assets/placeholders/jersey_${cleanRole}.png`;
};

// Country Flag and 3-Letter Code Mapper
function getCountryDetails(country, isOverseas) {
  const map = {
    'India': { flag: '🇮🇳', code: 'IND' },
    'Australia': { flag: '🇦🇺', code: 'AUS' },
    'England': { flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', code: 'ENG' },
    'South Africa': { flag: '🇿🇦', code: 'SA' },
    'New Zealand': { flag: '🇳🇿', code: 'NZ' },
    'West Indies': { flag: '🌴', code: 'WI' },
    'Afghanistan': { flag: '🇦🇫', code: 'AFG' },
    'Sri Lanka': { flag: '🇱🇰', code: 'SL' },
    'Bangladesh': { flag: '🇧🇩', code: 'BAN' }
  };
  if (country && map[country]) return map[country];
  return { flag: isOverseas ? '✈️' : '🇮🇳', code: country ? country.substring(0, 3).toUpperCase() : 'IND' };
}
const mySquadCount = document.getElementById('footer-squad') || document.getElementById('mySquadCount');
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

// New Broadcast Esports HUD Elements
const franchiseAuraLayer = document.getElementById('franchiseAuraLayer');
const panicScreenVignette = document.getElementById('panicScreenVignette');
const biddingWarBanner = document.getElementById('biddingWarBanner');
const cardHoloOverlay = document.getElementById('cardHoloOverlay');
const bidFloatChipContainer = document.getElementById('bidFloatChipContainer');

// Franchise Dynamic Aura Gradients
const FRANCHISE_AURAS = {
  CSK: 'radial-gradient(circle at 50% 50%, rgba(253, 216, 53, 0.16) 0%, transparent 70%)',
  RCB: 'radial-gradient(circle at 50% 50%, rgba(227, 26, 34, 0.18) 0%, transparent 70%)',
  MI: 'radial-gradient(circle at 50% 50%, rgba(0, 75, 160, 0.22) 0%, transparent 70%)',
  KKR: 'radial-gradient(circle at 50% 50%, rgba(58, 34, 93, 0.26) 0%, transparent 70%)',
  SRH: 'radial-gradient(circle at 50% 50%, rgba(242, 103, 34, 0.20) 0%, transparent 70%)',
  RR: 'radial-gradient(circle at 50% 50%, rgba(234, 26, 133, 0.20) 0%, transparent 70%)',
  DC: 'radial-gradient(circle at 50% 50%, rgba(0, 115, 207, 0.22) 0%, transparent 70%)',
  LSG: 'radial-gradient(circle at 50% 50%, rgba(0, 174, 239, 0.18) 0%, transparent 70%)',
  GT: 'radial-gradient(circle at 50% 50%, rgba(27, 33, 65, 0.28) 0%, transparent 70%)',
  PBKS: 'radial-gradient(circle at 50% 50%, rgba(221, 30, 48, 0.20) 0%, transparent 70%)'
};

function setFranchiseAura(franchiseId) {
  if (!franchiseAuraLayer) return;
  if (franchiseId && FRANCHISE_AURAS[franchiseId]) {
    franchiseAuraLayer.style.background = FRANCHISE_AURAS[franchiseId];
    franchiseAuraLayer.style.opacity = '1';
  } else {
    franchiseAuraLayer.style.background = 'radial-gradient(circle at 50% 40%, rgba(255, 184, 0, 0.08) 0%, transparent 65%)';
    franchiseAuraLayer.style.opacity = '0.7';
  }
}

// Session Cache & Restore Elements
const sessionRestoreBanner = document.getElementById('sessionRestoreBanner');
const sessionRestoreDetails = document.getElementById('sessionRestoreDetails');
const btnDismissRestore = document.getElementById('btnDismissRestore');
if (btnDismissRestore) {
  btnDismissRestore.addEventListener('click', () => {
    if (sessionRestoreBanner) sessionRestoreBanner.classList.add('hidden');
  });
}

// =========================================================================
// MULTI-MATCH CONCURRENCY ENGINE (Max 3 Active Matches)
// =========================================================================
const ACTIVE_SESSIONS_KEY = 'ipl_active_sessions';
let currentRole = 'manager'; // 'manager' | 'spectator'
let currentAllegiance = null;

// Persistent Client Identity (playerId Engine)
function getOrCreatePlayerId() {
  try {
    let id = localStorage.getItem('ipl_device_player_id');
    if (!id) {
      if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        id = 'usr_' + crypto.randomUUID().replace(/-/g, '').substring(0, 12);
      } else {
        id = 'usr_' + Math.random().toString(36).substring(2, 11) + Date.now().toString(36);
      }
      localStorage.setItem('ipl_device_player_id', id);
    }
    return id;
  } catch (e) {
    return 'usr_' + Math.random().toString(36).substring(2, 10);
  }
}

function generateClientSessionToken() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'tok_' + Math.random().toString(36).substring(2, 12) + '_' + Date.now();
}

function getActiveSessions() {
  try {
    const raw = localStorage.getItem(ACTIVE_SESSIONS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    const now = Date.now();
    let changed = false;
    // Prune stale sessions older than 24h to prevent ghost cache build-up
    for (const key of Object.keys(parsed)) {
      if (parsed[key].updatedAt && (now - parsed[key].updatedAt > 24 * 60 * 60 * 1000)) {
        delete parsed[key];
        changed = true;
      }
    }
    if (changed) {
      localStorage.setItem(ACTIVE_SESSIONS_KEY, JSON.stringify(parsed));
    }
    return parsed;
  } catch (e) {
    return {};
  }
}

function saveActiveSession(roomCode, managerName, teamId, token, role = 'manager', playerId = null) {
  if (!roomCode) return;
  const sessions = getActiveSessions();
  const c = roomCode.toUpperCase().trim();
  const pId = playerId || (sessions[c] ? sessions[c].playerId : null) || getOrCreatePlayerId();
  sessions[c] = {
    roomCode: c,
    playerId: pId,
    managerName: (managerName || 'Manager').trim(),
    teamId: teamId || null,
    sessionToken: token || (sessions[c] ? sessions[c].sessionToken : generateClientSessionToken()),
    role: role || (teamId ? 'manager' : 'spectator'),
    updatedAt: Date.now()
  };
  try {
    localStorage.setItem(ACTIVE_SESSIONS_KEY, JSON.stringify(sessions));
  } catch (e) {}
  renderOngoingMatches();
  return sessions[c];
}

// Backward compatibility alias for team claiming
function saveCurrentSession(roomCode, managerName, teamId) {
  return saveActiveSession(roomCode, managerName, teamId, null, 'manager');
}

function removeActiveSession(roomCode) {
  if (!roomCode) return;
  const sessions = getActiveSessions();
  const c = roomCode.toUpperCase().trim();
  delete sessions[c];
  try {
    localStorage.setItem(ACTIVE_SESSIONS_KEY, JSON.stringify(sessions));
  } catch (e) {}
  renderOngoingMatches();
}

function renderOngoingMatches() {
  const container = document.getElementById('ongoingMatchesContainer');
  const countBadge = document.getElementById('ongoingMatchesCount');
  const listEl = document.getElementById('ongoingMatchesList');
  if (!container || !listEl) return;

  const sessions = getActiveSessions();
  const keys = Object.keys(sessions);

  if (countBadge) countBadge.textContent = keys.length;

  if (keys.length === 0) {
    container.classList.add('hidden');
    listEl.innerHTML = '';
    return;
  }

  container.classList.remove('hidden');
  listEl.innerHTML = '';

  keys.forEach(c => {
    const s = sessions[c];
    const isCurrent = currentRoom && currentRoom.code === c;
    const card = document.createElement('div');
    card.className = `p-2.5 rounded-xl border flex items-center justify-between transition ${
      isCurrent ? 'bg-amber-500/15 border-amber-400' : 'bg-[#0b1227] border-white/10 hover:border-white/20'
    }`;

    const teamLogo = s.teamId ? `/logos/${s.teamId}.svg` : null;
    const teamBadge = s.teamId 
      ? `<span class="text-amber-400 font-black font-display text-xs">${s.teamId}</span>`
      : `<span class="text-laserCyan font-bold font-display text-[11px]">👁️ Spectator</span>`;

    card.innerHTML = `
      <div class="flex items-center space-x-2.5 min-w-0">
        <div class="w-10 h-10 rounded-xl bg-[#05070e] border border-white/10 flex items-center justify-center p-1.5 flex-shrink-0">
          ${teamLogo ? `<img src="${teamLogo}" alt="${s.teamId}" class="w-full h-full object-contain" />` : '<span class="text-base">👁️</span>'}
        </div>
        <div class="min-w-0">
          <div class="flex items-center space-x-1.5">
            <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
            <span class="font-mono font-bold text-white text-xs tracking-wider">${s.roomCode}</span>
            <span class="text-slate-600">•</span>
            ${teamBadge}
          </div>
          <div class="text-[11px] text-slate-300 font-sans truncate font-medium">${s.managerName}</div>
        </div>
      </div>
      <div class="flex items-center space-x-2 flex-shrink-0">
        <button class="btn-reenter-match min-h-[44px] px-3.5 py-2 rounded-xl bg-gradient-to-r from-amber-400 to-amber-500 hover:from-amber-300 text-slate-950 font-display font-black text-xs uppercase tracking-wider active:scale-95 transition shadow-lg shadow-amber-500/20 flex items-center gap-1 cursor-pointer" data-code="${s.roomCode}">
          <span>⚡ RESUME</span>
        </button>
        <button class="btn-abandon-match min-h-[44px] min-w-[44px] px-2.5 py-2 text-slate-400 hover:text-rose-400 rounded-xl hover:bg-rose-500/10 border border-white/10 hover:border-rose-500/30 text-xs transition flex items-center justify-center cursor-pointer" title="Leave Match" data-code="${s.roomCode}">
          <i class="fa-solid fa-xmark text-sm"></i>
        </button>
      </div>
    `;

    listEl.appendChild(card);
  });

  // Attach button event handlers
  listEl.querySelectorAll('.btn-reenter-match').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const code = btn.dataset.code;
      const targetSession = sessions[code];
      if (targetSession) {
        reconnectToRoom(targetSession.roomCode, targetSession);
      }
    });
  });

  listEl.querySelectorAll('.btn-abandon-match').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const code = btn.dataset.code;
      const targetSession = sessions[code];
      if (targetSession && socket && socket.connected) {
        socket.emit('leave_match', { sessionToken: targetSession.sessionToken });
      }
      removeActiveSession(code);
      if (currentRoom && currentRoom.code === code) {
        currentRoom = null;
        myTeam = null;
        navigate('home', null, true);
      }
      showToast(`Abandoned match [${code}]`, 'info');
    });
  });
}

function reconnectToRoom(roomCode, session) {
  if (!socket) socket = initSocket();
  const s = socket;
  if (!s) return;

  const pId = (session && session.playerId) || getOrCreatePlayerId();
  showToast(`Switching to Arena [${roomCode}]...`, 'info');

  s.emit('reconnect_session', {
    roomId: roomCode,
    roomCode: roomCode,
    playerId: pId,
    sessionToken: session.sessionToken,
    teamId: session.teamId,
    franchiseId: session.teamId,
    managerName: session.managerName
  }, (res) => {
    if (res && res.success) {
      currentRoom = res.roomState;
      isHost = (currentRoom.hostPlayerId === pId || s.id === currentRoom.hostId);
      currentRole = res.role || (res.team ? 'manager' : 'spectator');

      if (res.team) {
        myTeam = res.team;
      } else {
        myTeam = null;
      }
      if (res.franchiseRoster) {
        currentFranchiseRoster = res.franchiseRoster;
      }

      saveActiveSession(currentRoom.code, session.managerName, myTeam ? myTeam.franchiseId : null, res.sessionToken, currentRole, pId);

      if (roomBadge && currentRoomCode) {
        roomBadge.classList.remove('hidden');
        currentRoomCode.textContent = currentRoom.code;
      }

      updateUserFranchisePill();
      if (myTeam) setFranchiseAura(myTeam.franchiseId);

      if (currentRoom.status === 'AUCTION') {
        navigate('auction', currentRoom.code, true);
        updateAuctionView(currentRoom);
      } else if (currentRoom.status === 'FINISHED') {
        navigate('podium', currentRoom.code, true);
        renderPodium(currentRoom.standings || []);
      } else {
        navigate('lobby', currentRoom.code, true);
        setupLobby();
      }

      showToast(`Restored Arena [${currentRoom.code}]!`, 'success');
      playBeep(600, 'sine', 0.2);
    } else {
      showToast(res ? res.error : 'Session expired', 'error');
      removeActiveSession(roomCode);
    }
  });
}

let isRestoringSession = false;
function attemptSessionReentry() {
  if (isRestoringSession) return;
  const sessions = getActiveSessions();
  renderOngoingMatches();

  // Check URL parameters for direct room link: /lobby?room=XYZ or /auction?room=XYZ
  const params = new URLSearchParams(window.location.search);
  const urlRoom = params.get('room');
  const targetCode = urlRoom ? urlRoom.toUpperCase().trim() : null;

  if (targetCode) {
    if (sessions[targetCode]) {
      reconnectToRoom(targetCode, sessions[targetCode]);
      return;
    }
    // Direct link or refresh without cached session: query room directly
    const pId = getOrCreatePlayerId();
    const storedName = localStorage.getItem('ipl_manager_name') || 'Player ' + Math.floor(Math.random() * 90 + 10);
    reconnectToRoom(targetCode, {
      roomCode: targetCode,
      playerId: pId,
      managerName: storedName
    });
    return;
  }
}

// Micro-Shake Trigger (Optimized: targets viewAuction container directly to prevent reflowing entire document)
function triggerScreenMicroShake() {
  const target = document.getElementById('viewAuction') || viewAuction;
  if (!target) return;
  target.classList.remove('shake-active');
  requestAnimationFrame(() => {
    target.classList.add('shake-active');
    setTimeout(() => target.classList.remove('shake-active'), 240);
  });
}

// Floating Currency Feedback Animation (+₹25 L or +₹1 Cr) - High Visibility Broadcast Pill
function spawnFloatingCurrency(text) {
  if (!bidFloatChipContainer) return;
  const chip = document.createElement('div');
  chip.className = 'float-chip-anim px-2.5 sm:px-3 py-1 rounded-xl bg-gradient-to-r from-amber-300 via-amber-400 to-yellow-400 text-slate-950 font-black font-display text-xs sm:text-sm tracking-wider border border-white/90 inline-flex items-center gap-1.5 select-none shadow-2xl';
  chip.style.boxShadow = '0 8px 24px -2px rgba(245, 158, 11, 0.75), 0 0 16px rgba(255, 255, 255, 0.5)';
  chip.innerHTML = `<span class="text-emerald-950 font-black text-xs leading-none">▲</span><span>${text}</span>`;
  bidFloatChipContainer.appendChild(chip);
  setTimeout(() => chip.remove(), 1050);
}

// =========================================================================
// HTML5 HISTORY API STATE ROUTER & READ-ONLY LOCK GUARD
// =========================================================================
let currentViewState = 'home';
const lobbyMatchLockBanner = document.getElementById('lobbyMatchLockBanner');
const btnReturnToLiveAuction = document.getElementById('btnReturnToLiveAuction');

if (btnReturnToLiveAuction) {
  btnReturnToLiveAuction.addEventListener('click', () => {
    if (currentRoom) navigate('auction', currentRoom.code, true);
  });
}

function getRouteUrl(view, roomCode) {
  const code = (roomCode || (currentRoom ? currentRoom.code : '')).toUpperCase().trim();
  if (view === 'lobby') {
    return code ? `/lobby?room=${code}` : `/lobby`;
  } else if (view === 'auction') {
    return code ? `/auction?room=${code}` : `/auction`;
  } else if (view === 'podium' || view === 'finished') {
    return code ? `/podium?room=${code}` : `/podium`;
  }
  return '/';
}

function updateHeaderContext(viewName, roomCode = null) {
  const norm = String(viewName).toLowerCase().replace('view-', '').replace('view', '');
  const rBadge = document.getElementById('roomBadge');
  const rCode = document.getElementById('currentRoomCode');
  const userPill = document.getElementById('userFranchisePill');
  const lobbyCount = document.getElementById('lobbyPlayerCountBadge');
  const toggleDrawer = document.getElementById('toggleDrawerBtn');
  const codeToUse = roomCode || (currentRoom ? currentRoom.code : null);

  if (norm === 'home' || norm === 'welcome') {
    if (rBadge) rBadge.classList.add('hidden');
    if (userPill) userPill.classList.add('hidden');
    if (lobbyCount) lobbyCount.classList.add('hidden');
    if (toggleDrawer) toggleDrawer.classList.add('hidden');
  } else if (norm === 'lobby') {
    if (rBadge) {
      rBadge.classList.remove('hidden');
      rBadge.classList.add('flex');
      if (rCode && codeToUse) rCode.textContent = codeToUse;
    }
    if (userPill) userPill.classList.add('hidden');
    if (lobbyCount) {
      lobbyCount.classList.remove('hidden');
      lobbyCount.classList.add('flex');
      const countEl = document.getElementById('lobbyPlayerCountText');
      const total = currentRoom && currentRoom.teams ? currentRoom.teams.length : 0;
      if (countEl) countEl.textContent = `${total}/10`;
    }
    if (toggleDrawer) toggleDrawer.classList.add('hidden');
  } else if (norm === 'auction') {
    if (rBadge) {
      rBadge.classList.remove('hidden');
      rBadge.classList.add('flex');
      if (rCode && codeToUse) rCode.textContent = codeToUse;
    }
    if (userPill) {
      userPill.classList.remove('hidden');
      userPill.classList.add('flex');
      updateUserFranchisePill();
    }
    if (lobbyCount) lobbyCount.classList.add('hidden');
    if (toggleDrawer) {
      toggleDrawer.classList.remove('hidden');
      toggleDrawer.classList.add('flex');
    }
  } else if (norm === 'podium' || norm === 'finished') {
    if (rBadge) {
      rBadge.classList.remove('hidden');
      rBadge.classList.add('flex');
      if (rCode && codeToUse) rCode.textContent = codeToUse;
    }
    if (userPill) userPill.classList.add('hidden');
    if (lobbyCount) lobbyCount.classList.add('hidden');
    if (toggleDrawer) {
      toggleDrawer.classList.remove('hidden');
      toggleDrawer.classList.add('flex');
    }
  }
}

function showView(viewName, roomCode = null) {
  const norm = String(viewName).toLowerCase().replace('view-', '').replace('view', '');

  // Hide all viewports
  if (viewWelcome) viewWelcome.classList.add('hidden');
  if (viewLobby) viewLobby.classList.add('hidden');
  if (viewAuction) viewAuction.classList.add('hidden');
  if (viewFinished) viewFinished.classList.add('hidden');

  updateHeaderContext(norm, roomCode);

  if (norm === 'auction') {
    document.body.classList.add('in-auction-view');
  } else {
    document.body.classList.remove('in-auction-view');
  }

  if (norm === 'home' || norm === 'welcome') {
    currentViewState = 'home';
    if (viewWelcome) viewWelcome.classList.remove('hidden');
    renderOngoingMatches();
  } else if (norm === 'lobby') {
    currentViewState = 'lobby';
    if (viewLobby) viewLobby.classList.remove('hidden');

    renderFranchiseGrid();

    // Anti-Tamper Match Lock Guard:
    if (currentRoom && currentRoom.isStarted) {
      if (lobbyMatchLockBanner) lobbyMatchLockBanner.classList.remove('hidden');
      renderLobbyReadOnlyMode();
    } else {
      if (lobbyMatchLockBanner) lobbyMatchLockBanner.classList.add('hidden');
      restoreLobbyInteractiveMode();
    }
  } else if (norm === 'auction') {
    currentViewState = 'auction';
    if (viewAuction) {
      viewAuction.classList.remove('hidden');
      viewAuction.classList.add('flex');
    }
    if (currentRole === 'spectator') {
      setupSpectatorUI();
    } else {
      setupManagerUI();
    }
  } else if (norm === 'podium' || norm === 'finished') {
    currentViewState = 'podium';
    if (viewFinished) viewFinished.classList.remove('hidden');
  }
}

function renderLobbyReadOnlyMode() {
  if (franchiseGrid) {
    franchiseGrid.querySelectorAll('.franchise-3d-card').forEach(card => {
      card.classList.add('opacity-50', 'pointer-events-none');
    });
  }
  if (btnStartAuctionHost) btnStartAuctionHost.classList.add('hidden');
  if (btnOpenRetentionModal) btnOpenRetentionModal.classList.add('hidden');
}

function restoreLobbyInteractiveMode() {
  if (franchiseGrid) {
    franchiseGrid.querySelectorAll('.franchise-3d-card').forEach(card => {
      card.classList.remove('opacity-50', 'pointer-events-none');
    });
  }
  if (btnOpenRetentionModal) btnOpenRetentionModal.classList.remove('hidden');
  if (isHost && btnStartAuctionHost) btnStartAuctionHost.classList.remove('hidden');
}

function navigate(viewName, roomCode = null, pushState = true) {
  const norm = String(viewName).toLowerCase().replace('view-', '').replace('view', '');
  const targetCode = roomCode || (currentRoom ? currentRoom.code : null);
  const routeUrl = getRouteUrl(norm, targetCode);

  if (pushState) {
    try {
      if (window.location.pathname + window.location.search !== routeUrl) {
        history.pushState({ view: norm, roomCode: targetCode }, '', routeUrl);
      }
    } catch (e) {
      // Fallback for isolated blob/local protocols
      window.location.hash = '#' + norm;
    }
  }

  showView(norm, targetCode);
}

// Backward compatibility alias
function switchView(viewName) {
  navigate(viewName, currentRoom ? currentRoom.code : null, true);
}

// Browser Back / Forward Button Popstate Listener
window.addEventListener('popstate', (e) => {
  if (currentViewState === 'auction' && currentRoom && currentRoom.status === 'AUCTION') {
    try {
      history.pushState({ view: 'auction', roomCode: currentRoom.code }, '', window.location.href);
    } catch (err) {}
    openConfirmExitModal(() => {
      if (currentRoom) removeActiveSession(currentRoom.code);
      performSessionCleanupBeforeNewMatch();
      navigate('home', null, true);
      showToast('Left match. Returned to Home.', 'info');
    });
    return;
  }

  const state = e.state;
  let view = state && state.view;
  let roomCode = state && state.roomCode;

  if (!view) {
    const path = window.location.pathname.toLowerCase();
    const params = new URLSearchParams(window.location.search);
    const qRoom = params.get('room');
    if (qRoom) roomCode = qRoom.toUpperCase();

    if (path.includes('lobby') || window.location.hash.includes('lobby')) view = 'lobby';
    else if (path.includes('auction') || window.location.hash.includes('auction')) view = 'auction';
    else if (path.includes('podium') || window.location.hash.includes('podium')) view = 'podium';
    else view = 'home';
  }

  showView(view, roomCode);
});

// Browser tab close / reload protection during live auction
window.addEventListener('beforeunload', (e) => {
  if (currentViewState === 'auction' && currentRoom && currentRoom.status === 'AUCTION') {
    e.preventDefault();
    e.returnValue = 'Are you sure you want to leave the live auction room?';
    return e.returnValue;
  }
});

// Non-Intrusive Centered Toast Notifications with 2.5s Deduplication
let lastToastMessage = '';
let lastToastTime = 0;

function showToast(message, type = 'info') {
  if (!message || !toastContainer) return;
  const now = Date.now();
  if (lastToastMessage === message && (now - lastToastTime < 2500)) {
    return; // Deduplicate identical messages to prevent double/triple popups
  }
  lastToastMessage = message;
  lastToastTime = now;

  // Enforce single active toast: remove existing to prevent screen-covering stacks
  while (toastContainer.firstChild) {
    toastContainer.removeChild(toastContainer.firstChild);
  }

  const toast = document.createElement('div');
  const bgClasses = {
    info: 'bg-[#0b1227]/95 border-slate-700 text-slate-100 shadow-slate-950/80',
    success: 'bg-emerald-950/95 border-emerald-500/70 text-emerald-100 shadow-emerald-950/80',
    error: 'bg-rose-950/95 border-rose-500/70 text-rose-100 shadow-rose-950/80',
    warning: 'bg-amber-950/95 border-amber-500/70 text-amber-100 shadow-amber-950/80'
  };

  toast.className = `py-1.5 px-3.5 rounded-full border shadow-2xl flex items-center space-x-2 text-[11px] sm:text-xs font-semibold backdrop-blur-md transition-all duration-300 pointer-events-auto transform -translate-y-2 opacity-0 select-none ${bgClasses[type] || bgClasses.info}`;
  toast.innerHTML = `
    <i class="fa-solid ${type === 'error' ? 'fa-circle-xmark text-rose-400' : type === 'success' ? 'fa-circle-check text-emerald-400' : type === 'warning' ? 'fa-triangle-exclamation text-amber-400' : 'fa-bell text-laserCyan'} text-xs"></i>
    <span class="truncate max-w-[280px] sm:max-w-sm">${message}</span>
  `;

  toastContainer.appendChild(toast);
  requestAnimationFrame(() => toast.classList.remove('-translate-y-2', 'opacity-0'));
  setTimeout(() => {
    toast.classList.add('opacity-0', '-translate-y-2');
    setTimeout(() => toast.remove(), 250);
  }, 3000);
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
  const sessions = getActiveSessions();
  if (Object.keys(sessions).length >= 3) {
    showToast('Active match limit reached (3/3)! Please abandon one of your ongoing matches first.', 'error');
    return;
  }

  const mName = (inputManagerName ? inputManagerName.value : 'Host').trim();
  if (Object.values(sessions).some(s => s.managerName.toLowerCase() === mName.toLowerCase())) {
    showToast(`Handle "${mName}" is already active in another match. Please use a unique alias.`, 'warning');
    return;
  }

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

  const inputMinSquadEl = document.getElementById('inputMinSquad');
  const minSquadSize = inputMinSquadEl ? inputMinSquadEl.value : 15;
  const initialPurse = document.getElementById('selectInitialPurse').value;
  const retentionsAllowed = document.getElementById('selectRetentionsAllowed').value;
  const maxSquadSize = document.getElementById('inputMaxSquad').value;
  const maxOverseas = document.getElementById('inputMaxOverseas').value;

  const performCreate = () => {
    const pId = getOrCreatePlayerId();
    socket.emit('create_room', {
      initialPurse,
      retentionsAllowed,
      maxSquadSize,
      minSquadSize,
      maxOverseas,
      managerName: mName,
      playerId: pId
    }, (res) => {
      clearTimeout(timeout);
      btnSubmitCreateRoom.disabled = false;
      btnSubmitCreateRoom.innerHTML = origHTML;

      if (res && res.success) {
        currentRoom = res.roomState;
        isHost = true;
        currentRole = 'manager';
        myTeam = null;
        saveActiveSession(res.roomCode, mName, null, res.sessionToken, 'manager', res.playerId || pId);
        navigate('lobby', res.roomCode, true);
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

// Join Room Action (Manager or Spectator)
function joinRoomAction(asSpectator = false) {
  const roomCode = inputJoinRoomCode.value.trim().toUpperCase();
  if (!roomCode) return showToast('Please enter room code', 'warning');

  const sessions = getActiveSessions();
  if (Object.keys(sessions).length >= 3 && !sessions[roomCode]) {
    showToast('Active match limit reached (3/3)! Please abandon one of your ongoing matches first.', 'error');
    return;
  }

  const mName = (inputManagerName ? inputManagerName.value : 'Player').trim();
  if (Object.values(sessions).some(s => s.roomCode !== roomCode && s.managerName.toLowerCase() === mName.toLowerCase())) {
    showToast(`Handle "${mName}" is already active in another match. Please use a unique alias.`, 'warning');
    return;
  }

  if (!socket) {
    socket = initSocket();
  }

  const activeBtn = asSpectator ? btnSubmitJoinSpectator : btnSubmitJoinRoom;
  const origHTML = activeBtn ? activeBtn.innerHTML : '';
  if (activeBtn) {
    activeBtn.disabled = true;
    activeBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-1.5"></i> ${asSpectator ? 'Spectating...' : 'Entering...'}`;
  }

  const timeout = setTimeout(() => {
    if (activeBtn) {
      activeBtn.disabled = false;
      activeBtn.innerHTML = origHTML;
    }
    showToast('Server response timed out. Please check your room code or connection.', 'warning');
  }, 12000);

  const performJoin = () => {
    const pId = getOrCreatePlayerId();
    socket.emit('join_room', { roomCode, managerName: mName, playerId: pId, asSpectator }, (res) => {
      clearTimeout(timeout);
      if (activeBtn) {
        activeBtn.disabled = false;
        activeBtn.innerHTML = origHTML;
      }

      if (res && res.success) {
        currentRoom = res.roomState;
        isHost = (currentRoom.hostPlayerId === pId || currentRoom.hostId === socket.id);
        currentRole = res.role || (asSpectator || currentRoom.isStarted ? 'spectator' : 'manager');
        myTeam = null;

        saveActiveSession(roomCode, mName, null, res.sessionToken, currentRole, pId);

        if (currentRole === 'spectator' || currentRoom.isStarted) {
          navigate('auction', roomCode, true);
          updateAuctionView(currentRoom);
          showToast(`Joined Arena [${roomCode}] as Spectator! 👓`, 'info');
        } else {
          navigate('lobby', roomCode, true);
          setupLobby();
          showToast(`Joined room [${roomCode}]!`, 'success');
        }
        updateSpectatorButtonLabels();
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
      if (activeBtn) {
        activeBtn.disabled = false;
        activeBtn.innerHTML = origHTML;
      }
      showToast('Could not establish connection to cloud server.', 'error');
    }
  }
}

btnSubmitJoinRoom.addEventListener('click', () => joinRoomAction(false));
if (btnSubmitJoinSpectator) {
  btnSubmitJoinSpectator.addEventListener('click', () => joinRoomAction(true));
}

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
  if (roomBadge) roomBadge.classList.remove('hidden');
  if (currentRoom && currentRoom.code) {
    if (currentRoomCode) currentRoomCode.textContent = currentRoom.code;
    if (lobbyRoomCode) lobbyRoomCode.textContent = currentRoom.code;
  }

  if (isHost) {
    if (hostNotice) hostNotice.classList.remove('hidden');
    if (btnStartAuctionHost) btnStartAuctionHost.classList.remove('hidden');
    if (btnHostSkipPlayer) btnHostSkipPlayer.classList.remove('hidden');
    if (btnHostUndoSkipPlayer) btnHostUndoSkipPlayer.classList.remove('hidden');
  } else {
    if (hostNotice) hostNotice.classList.add('hidden');
    if (btnStartAuctionHost) btnStartAuctionHost.classList.add('hidden');
    if (btnHostSkipPlayer) btnHostSkipPlayer.classList.add('hidden');
    if (btnHostUndoSkipPlayer) btnHostUndoSkipPlayer.classList.add('hidden');
  }

  renderFranchiseGrid();
  updateDrawerTeams();
  updateLobbyRetentionBanner();
}

// Render Available Franchises with 3D Collectible Cards & Dynamic Hover Auras
function renderFranchiseGrid() {
  if (!franchiseGrid) return;
  franchiseGrid.innerHTML = '';
  const takenMap = new Map();
  const teams = (currentRoom && currentRoom.teams) ? currentRoom.teams : [];
  teams.forEach(t => takenMap.set(t.franchiseId, t));

  FRANCHISES.forEach(f => {
    const isTaken = takenMap.has(f.id);
    const isMine = myTeam && myTeam.franchiseId === f.id;
    const teamOwner = takenMap.get(f.id);

    const card = document.createElement('div');
    card.className = `franchise-3d-card p-3 sm:p-4 rounded-3xl border flex flex-col items-center justify-between transition-all relative overflow-hidden backdrop-blur-xl ${
      isMine
        ? 'border-amber-400 bg-gradient-to-b from-amber-500/20 to-[#0e1730] shadow-2xl shadow-amber-500/30 ring-2 ring-amber-400/80 scale-[1.02]'
        : isTaken
        ? 'opacity-40 border-white/5 bg-[#080d1e] cursor-not-allowed'
        : 'border-white/10 bg-[#0d1324]/80 hover:border-amber-400/60 hover:bg-[#121a32] cursor-pointer shadow-lg'
    }`;

    // Franchise subtle colored backdrop glow
    const teamGlow = f.color ? `box-shadow: 0 10px 25px -5px ${f.color}25;` : '';

    card.innerHTML = `
      ${isMine ? '<div class="absolute top-2 right-2 text-amber-400 text-xs"><i class="fa-solid fa-crown animate-bounce"></i></div>' : ''}
      <div class="w-16 h-16 sm:w-18 sm:h-18 p-1.5 mb-2 flex items-center justify-center relative">
        <img src="${f.logo}" alt="${f.name}" class="w-full h-full object-contain filter drop-shadow-xl transform group-hover:scale-110 transition duration-300" />
      </div>
      <div class="font-black font-display text-sm text-center text-white mb-0.5 tracking-wider uppercase">${f.id}</div>
      <div class="text-[10px] text-slate-400 text-center truncate w-full mb-3 font-sans">${f.name}</div>
      ${
        isMine 
          ? `<span class="px-3 py-1 text-[9px] font-black font-display rounded-full bg-gradient-to-r from-amber-500 to-amber-400 text-slate-950 uppercase tracking-widest shadow-md">WAR ROOM ACTIVE</span>`
          : isTaken 
          ? `<span class="px-2.5 py-0.5 text-[9px] font-bold rounded-full bg-[#121a32] text-slate-400 truncate max-w-full font-mono border border-white/10">LOCKED: ${teamOwner.managerName}</span>`
          : `<span class="shimmer-btn px-3 py-1 text-[9px] font-black font-display rounded-full bg-victoryEmerald/20 text-victoryEmerald border border-victoryEmerald/40 uppercase tracking-wider hover:bg-victoryEmerald hover:text-slate-950 transition">CLAIM CREST</span>`
      }
    `;

    if (!isTaken) {
      card.addEventListener('click', () => {
        setFranchiseAura(f.id);
        selectFranchise(f.id);
      });
    }

    franchiseGrid.appendChild(card);
  });
}

// Select Franchise & Automatically Pop Open the Retention Window
function selectFranchise(franchiseId) {
  const managerName = inputManagerName.value.trim() || 'Player ' + Math.floor(Math.random() * 90 + 10);
  const pId = getOrCreatePlayerId();
  socket.emit('select_team', { franchiseId, managerName, playerId: pId }, (res) => {
    if (res && res.success) {
      myTeam = res.team;
      currentFranchiseRoster = res.franchiseRoster || [];
      mySelectedRetentions = res.team.retentions || [];
      saveActiveSession(currentRoom.code, managerName, myTeam.franchiseId, null, 'manager', pId);
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
  if (userFranchisePill) {
    userFranchisePill.classList.remove('hidden');
    userFranchisePill.classList.add('flex');
  }
  if (userFranchiseLogo) userFranchiseLogo.src = myTeam.logo || `/logos/${myTeam.franchiseId}.svg`;
  if (userFranchiseTag) userFranchiseTag.textContent = myTeam.franchiseId;
  if (userPurseDisplay) userPurseDisplay.textContent = formatCurrency(myTeam.purse);

  if (myPurseAmount) myPurseAmount.textContent = formatCurrency(myTeam.purse);
  const maxSquad = (currentRoom && currentRoom.settings && currentRoom.settings.maxSquadSize) || 25;
  const maxOS = (currentRoom && currentRoom.settings && currentRoom.settings.maxOverseas) || 8;
  if (mySquadCount) mySquadCount.textContent = `${myTeam.squadCount || 0}/${maxSquad}`;
  if (myOverseasCount) myOverseasCount.textContent = `${myTeam.overseasCount || 0}/${maxOS}`;
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
    fetch(`${CLOUD_BACKEND_URL}/api/franchise-players/${myTeam.franchiseId}`)
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

    const tierBadge = retentionIndex === 0 
      ? '<span class="text-[9px] px-1.5 py-0.5 rounded bg-amber-400 text-slate-950 font-black font-display tracking-wider">TIER 1 (GOLD)</span>'
      : retentionIndex === 1 
      ? '<span class="text-[9px] px-1.5 py-0.5 rounded bg-slate-300 text-slate-950 font-black font-display tracking-wider">TIER 2 (SILVER)</span>'
      : '<span class="text-[9px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-300 font-bold font-display tracking-wider">CORE</span>';

    const card = document.createElement('div');
    card.className = `p-3.5 rounded-3xl border transition-all cursor-pointer flex flex-col justify-between relative overflow-hidden backdrop-blur-xl ${
      isRetained 
        ? 'border-amber-400 bg-gradient-to-b from-amber-500/20 to-[#0d1324] shadow-2xl shadow-amber-500/20 ring-2 ring-amber-400/70 scale-[1.01]' 
        : 'border-white/10 bg-[#0d1324]/90 hover:border-white/25 hover:bg-[#121a32]'
    }`;

    card.innerHTML = `
      <div class="flex items-start space-x-3 mb-2.5">
        <div class="relative flex-shrink-0">
          <img 
            src="${player.photo}" 
            alt="${player.name}" 
            class="w-16 h-16 rounded-2xl object-cover object-top border-2 border-white/15 shadow-xl" 
            onerror="this.src='/icons/player_avatar.svg'"
          />
          ${
            isRetained 
              ? `<span class="absolute -top-1.5 -right-1.5 w-6 h-6 rounded-full bg-gradient-to-br from-amber-400 to-amber-500 text-slate-950 font-black text-xs flex items-center justify-center shadow-lg border border-white"><i class="fa-solid fa-lock text-[10px]"></i></span>`
              : ''
          }
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center space-x-1.5">
            <h4 class="font-black font-display text-sm text-white truncate tracking-wide">${player.name}</h4>
            ${player.isOverseas ? '<span class="text-[9px] px-1 rounded bg-blue-500/30 text-laserCyan font-mono font-bold">OS</span>' : ''}
          </div>
          <div class="flex items-center space-x-1.5 mt-0.5">
            <span class="px-2 py-0.5 rounded text-[9px] font-black font-display border ${roleColors[player.role] || 'bg-slate-800 text-slate-300'}">${player.role}</span>
            <span class="text-[10px] text-slate-400 font-mono truncate">• ${player.country}</span>
          </div>
          <div class="text-[10px] text-slate-400 font-mono mt-1.5 bg-[#05070e] px-2 py-1 rounded-lg border border-white/5 inline-block">
            ${player.stats.matches} M • ${player.stats.runs || 0} R • ${player.stats.wickets || 0} W
          </div>
        </div>
      </div>

      <div class="pt-2.5 border-t border-white/10 flex items-center justify-between">
        <div class="text-[11px] font-mono">
          <span class="text-slate-400 text-[10px]">Slot Cost:</span> 
          <b class="text-amber-400 font-bold">${formatCurrency(slotCost)}</b>
        </div>
        <button class="px-3.5 py-1.5 rounded-xl text-[10px] font-black font-display uppercase tracking-wider transition ${
          isRetained 
            ? 'bg-amber-400 text-slate-950 shadow-lg shadow-amber-500/30' 
            : 'bg-[#162347] hover:bg-[#1e3060] text-slate-200 border border-white/15'
        }">
          ${isRetained ? 'LOCKED ✓' : 'RETAIN +'}
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
if (btnHostSkipPlayer) {
  btnHostSkipPlayer.addEventListener('click', () => {
    if (!confirm('Pass / skip this player to unsold?')) return;
    socket.emit('skip_player', {}, (res) => {
      if (!res || !res.success) {
        showToast(res ? res.error : 'Failed to skip', 'error');
      }
    });
  });
}

// Host Undo Skip Player
if (btnHostUndoSkipPlayer) {
  btnHostUndoSkipPlayer.addEventListener('click', () => {
    socket.emit('undo_skip_player', {}, (res) => {
      if (res && res.success) {
        showToast('Restored skipped player to hammer!', 'success');
      } else {
        showToast(res ? res.error : 'Nothing to undo', 'warning');
      }
    });
  });
}

// Update Live Auction View
function updateAuctionView(room) {
  switchView('AUCTION');
  const player = room.currentPlayer;
  if (!player) return;

  window.currentPlayerRole = player.role || 'Batter';
  const role = (player.role || 'Batter').trim();
  const roleUpper = role.toUpperCase();

  // Reset active lot bid history and fold state on new player lot
  if (player.id !== lastLotPlayerId) {
    lastLotPlayerId = player.id;
    activeLotBidHistory = [];
    renderRecentBidsFeed();

    // Clear folds on lot change
    if (currentRoom) {
      currentRoom.foldedTeams = Array.isArray(room.foldedTeams) ? [...room.foldedTeams] : [];
    }
    if (myTeam) {
      myTeam.isFolded = false;
    }
    if (btnFoldPlayer) {
      btnFoldPlayer.disabled = false;
      if (foldButtonText) foldButtonText.textContent = 'FOLD';
      btnFoldPlayer.classList.remove('opacity-40', 'border-emerald-500/50', 'text-emerald-400', 'border-cyan-500/50', 'text-cyan-400');
    }
  }

  if (playerSoldWatermark) playerSoldWatermark.classList.add('hidden');
  if (playerUnsoldWatermark) playerUnsoldWatermark.classList.add('hidden');

  // 1. Role-Specific Lot Ribbon Badge
  const lotTag = document.getElementById('player-lot-tag');
  if (lotTag) {
    lotTag.textContent = `LOT #${room.auctionIndex + 1} • ${roleUpper}`;
  }

  // 2. Timer Flank Icons based on Role
  const iconLeft = document.getElementById('timer-icon-left');
  const iconRight = document.getElementById('timer-icon-right');
  if (role === 'Batter') {
    if (iconLeft) iconLeft.innerHTML = '🏏';
    if (iconRight) iconRight.innerHTML = '🏏';
  } else if (role === 'Wicketkeeper') {
    if (iconLeft) iconLeft.innerHTML = '🧤';
    if (iconRight) iconRight.innerHTML = '🧤';
  } else if (role === 'All-Rounder') {
    if (iconLeft) iconLeft.innerHTML = '🏏';
    if (iconRight) iconRight.innerHTML = '🔴';
  } else {
    // Bowler
    if (iconLeft) iconLeft.innerHTML = '🔴';
    if (iconRight) iconRight.innerHTML = '🧤';
  }

  // 3. Player Portrait Photo with error fallback
  if (playerImage) {
    playerImage.onerror = function() {
      window.handlePlayerImageError(this, player.role);
    };
    playerImage.src = player.image || player.photo;
  }

  // 4. OVR Rating Shield
  const playerOvrEl = document.getElementById('player-ovr');
  if (playerOvrEl) playerOvrEl.textContent = player.rating || 85;

  // 5. Player Name & Country Code
  if (playerName) playerName.textContent = player.name;
  const countryInfo = getCountryDetails(player.country, player.isOverseas);
  const playerFlagEl = document.getElementById('player-flag');
  const playerCountryEl = document.getElementById('player-country');
  if (playerFlagEl) playerFlagEl.textContent = countryInfo.flag;
  if (playerCountryEl) playerCountryEl.textContent = countryInfo.code;

  // 6. Base Price Plaque
  const playerBasePriceEl = document.getElementById('player-base-price');
  if (playerBasePriceEl) playerBasePriceEl.textContent = formatCurrency(player.basePrice).toUpperCase();

  // 7. Dynamic 4-Stat Strip based on Role
  const statIcon1 = document.getElementById('stat-icon-1');
  const statLabel1 = document.getElementById('stat-label-1');
  const statVal1 = document.getElementById('stat-col1');

  const statIcon2 = document.getElementById('stat-icon-2');
  const statLabel2 = document.getElementById('stat-label-2');
  const statVal2 = document.getElementById('stat-col2');

  const statIcon3 = document.getElementById('stat-icon-3');
  const statLabel3 = document.getElementById('stat-label-3');
  const statVal3 = document.getElementById('stat-col3');

  const statIcon4 = document.getElementById('stat-icon-4');
  const statLabel4 = document.getElementById('stat-label-4');
  const statVal4 = document.getElementById('stat-col4');

  // Col 1: Matches (All roles)
  if (statIcon1) statIcon1.innerHTML = '🪖';
  if (statLabel1) statLabel1.textContent = 'MAT';
  if (statVal1) statVal1.textContent = player.stats.matches || 0;

  if (role === 'Batter') {
    if (statIcon2) statIcon2.innerHTML = '🏏';
    if (statLabel2) statLabel2.textContent = 'RUNS';
    if (statVal2) statVal2.textContent = player.stats.runs || 0;

    if (statIcon3) statIcon3.innerHTML = '📈';
    if (statLabel3) statLabel3.textContent = 'AVG';
    if (statVal3) statVal3.textContent = player.stats.average || '-';

    if (statIcon4) statIcon4.innerHTML = '⏱️';
    if (statLabel4) statLabel4.textContent = 'SR';
    if (statVal4) statVal4.textContent = player.stats.strikeRate || '-';
  } else if (role === 'Wicketkeeper') {
    if (statIcon2) statIcon2.innerHTML = '🏏';
    if (statLabel2) statLabel2.textContent = 'RUNS';
    if (statVal2) statVal2.textContent = player.stats.runs || 0;

    if (statIcon3) statIcon3.innerHTML = '🧤';
    if (statLabel3) statLabel3.textContent = 'DIS';
    if (statVal3) statVal3.textContent = player.stats.dismissals || player.stats.catches || (player.stats.wickets ? player.stats.wickets : 112);

    if (statIcon4) statIcon4.innerHTML = '⏱️';
    if (statLabel4) statLabel4.textContent = 'SR';
    if (statVal4) statVal4.textContent = player.stats.strikeRate || '-';
  } else if (role === 'All-Rounder') {
    if (statIcon2) statIcon2.innerHTML = '🏏';
    if (statLabel2) statLabel2.textContent = 'RUNS';
    if (statVal2) statVal2.textContent = player.stats.runs || 0;

    if (statIcon3) statIcon3.innerHTML = '🎯';
    if (statLabel3) statLabel3.textContent = 'WKTS';
    if (statVal3) statVal3.textContent = player.stats.wickets || 0;

    if (statIcon4) statIcon4.innerHTML = '⏱️';
    if (statLabel4) statLabel4.textContent = 'SR';
    if (statVal4) statVal4.textContent = player.stats.strikeRate || '-';
  } else {
    // Bowler
    if (statIcon2) statIcon2.innerHTML = '🎯';
    if (statLabel2) statLabel2.textContent = 'WKTS';
    if (statVal2) statVal2.textContent = player.stats.wickets || 0;

    if (statIcon3) statIcon3.innerHTML = '📊';
    if (statLabel3) statLabel3.textContent = 'ECON';
    if (statVal3) statVal3.textContent = player.stats.economy || '-';

    if (statIcon4) statIcon4.innerHTML = '🎯';
    if (statLabel4) statLabel4.textContent = 'BEST';
    if (statVal4) statVal4.textContent = player.stats.bestBowling || player.stats.best || '-';
  }

  // 8. Current Bid & Spotlight Box
  if (currentBidAmount) currentBidAmount.textContent = formatCurrency(room.currentBid);

  // Highest bidder tag
  const leadingBidderDot = document.getElementById('leading-bidder-dot');
  if (room.highestBidder) {
    if (highestBidderName) highestBidderName.textContent = `👑 ${room.highestBidder.teamId} (${room.highestBidder.managerName})`;
    if (leadingBidderDot) leadingBidderDot.className = 'w-2 h-2 rounded-full bg-emerald-500 animate-ping inline-block';
  } else {
    if (highestBidderName) highestBidderName.textContent = 'WAITING FOR BID';
    if (leadingBidderDot) leadingBidderDot.className = 'w-2 h-2 rounded-full bg-slate-500 inline-block';
  }

  // 9. Synchronize Mobile & Desktop Headers & Spectator Mode
  const isSpectator = (currentRole === 'spectator' || !myTeam);
  if (isSpectator) {
    setupSpectatorUI();
  } else {
    setupManagerUI();
    const franchiseId = myTeam ? myTeam.franchiseId : 'CSK';
    const purseText = myTeam ? formatCurrency(myTeam.purse) : 'Live';
    const logoSrc = `/logos/${franchiseId}.svg`;

    const headerTeamBadge = document.getElementById('header-team-badge');
    const headerPurseVal = document.getElementById('header-purse-val');
    const headerTeamLogo = document.getElementById('header-team-logo');

    const desktopTeamBadge = document.getElementById('desktop-team-badge');
    const desktopPurseVal = document.getElementById('desktop-purse-val');
    const desktopTeamLogo = document.getElementById('desktop-team-logo');

    if (headerTeamBadge) headerTeamBadge.textContent = franchiseId;
    if (headerPurseVal) headerPurseVal.textContent = purseText;
    if (headerTeamLogo) headerTeamLogo.src = logoSrc;

    if (desktopTeamBadge) desktopTeamBadge.textContent = franchiseId;
    if (desktopPurseVal) desktopPurseVal.textContent = purseText;
    if (desktopTeamLogo) desktopTeamLogo.src = logoSrc;
  }

  const headerRoomCode = document.getElementById('header-room-code');
  const desktopRoomCode = document.getElementById('desktop-room-code');
  if (headerRoomCode && room.code) headerRoomCode.textContent = `#${room.code}`;
  if (desktopRoomCode && room.code) desktopRoomCode.textContent = `#${room.code}`;

  const squadCount = myTeam ? (myTeam.squadCount || (myTeam.squad ? myTeam.squad.length : 0)) : 0;
  const maxSquad = (room.settings && room.settings.maxSquadSize) || 25;
  if (desktopSquad) desktopSquad.textContent = `${squadCount}/${maxSquad}`;
  if (desktopPurse) desktopPurse.textContent = purseText;

  // 10. Synchronize Mobile Telemetry Sub-line
  const footerSquad = document.getElementById('footer-squad');
  const footerPurse = document.getElementById('footer-purse');
  const footerFolds = document.getElementById('footer-folds');
  if (footerSquad) footerSquad.textContent = `${squadCount}/${maxSquad}`;
  if (footerPurse) footerPurse.textContent = purseText;
  const foldsCount = (room.foldedTeams && room.foldedTeams.length) || 0;
  const totalTeams = (room.teams && room.teams.length) || 10;
  if (footerFolds) footerFolds.textContent = `${foldsCount}/${Math.max(totalTeams - 1, 1)}`;

  // Timer idle state if not started yet
  if (!room.isTimerRunning) {
    if (auctionTimer) {
      auctionTimer.textContent = '--';
      auctionTimer.classList.remove('text-red-500', 'animate-ping');
      auctionTimer.classList.add('text-slate-400');
    }
  }

  // Host Controls Visibility
  if (isHost && btnHostConcludeAuction) {
    btnHostConcludeAuction.classList.remove('hidden');
    btnHostConcludeAuction.classList.add('flex');
    const minSquad = (room.settings && room.settings.minSquadSize) || 15;
    const canConclude = (room.teams || []).length > 0 && (room.teams || []).every(t => (t.squadCount || t.squad.length) >= minSquad);
    btnHostConcludeAuction.disabled = !canConclude;
  } else if (btnHostConcludeAuction) {
    btnHostConcludeAuction.classList.add('hidden');
  }

  if (btnHostUndoSkipPlayer) {
    if (isHost && room.canUndoSkip) {
      btnHostUndoSkipPlayer.classList.remove('hidden');
      btnHostUndoSkipPlayer.classList.add('flex');
    } else {
      btnHostUndoSkipPlayer.classList.add('hidden');
    }
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
    bidButtonText.innerHTML = `<span>🔨 OPEN BID (${formatCurrency(nextAmount).toUpperCase()})</span>`;
  } else {
    inc = calculateIncrement(currentBid);
    nextAmount = currentBid + inc;
    const incLabel = inc >= 10000000 ? `+₹${(inc / 10000000).toFixed(2)} Cr` : `+${(inc / 100000).toFixed(0)}L`;
    bidButtonText.innerHTML = `<span>🔨 BID ${formatCurrency(nextAmount)}</span> <span class="text-xs font-mono font-bold opacity-80">(${incLabel})</span>`;
  }

  bidStatusNotice.classList.add('hidden');
  btnPlaceBid.disabled = false;
  btnPlaceBid.classList.remove('from-emerald-500', 'to-emerald-400', 'text-slate-950', 'ring-2', 'ring-emerald-400');
  btnPlaceBid.classList.add('from-amber-500', 'to-amber-400');

  let cannotBidReason = null;
  if (!myTeam) {
    cannotBidReason = 'Select a team first to place bids';
  } else if (currentRoom.highestBidder && (currentRoom.highestBidder.socketId === socket.id || currentRoom.highestBidder.teamId === myTeam.franchiseId)) {
    // Leading bidder state handled separately
  } else if (myTeam.purse < nextAmount) {
    cannotBidReason = `Insufficient purse! Needed ${formatCurrency(nextAmount)}`;
  } else if (myTeam.squadCount >= currentRoom.settings.maxSquadSize) {
    cannotBidReason = `Squad full (${currentRoom.settings.maxSquadSize} players)`;
  } else if (currentRoom.currentPlayer.isOverseas && myTeam.overseasCount >= currentRoom.settings.maxOverseas) {
    cannotBidReason = `Overseas slots full (${currentRoom.settings.maxOverseas} max)`;
  }

  // Configure Bid Button State
  const totalTeams = (currentRoom && currentRoom.teams) ? currentRoom.teams.length : 0;
  const isSoloTesting = totalTeams <= 1;

  const isHighestBidder = !isSoloTesting && currentRoom && currentRoom.highestBidder && myTeam && 
    (currentRoom.highestBidder.socketId === (socket ? socket.id : null) || currentRoom.highestBidder.teamId === myTeam.franchiseId);

  const foldedList = (currentRoom && currentRoom.foldedTeams) || [];
  const hasFolded = myTeam && foldedList.includes(myTeam.franchiseId);

  if (isHighestBidder) {
    btnPlaceBid.disabled = true;
    btnPlaceBid.classList.remove('from-amber-500', 'to-amber-400', 'from-amber-600', 'to-amber-500');
    btnPlaceBid.classList.add('from-emerald-500', 'to-emerald-400', 'text-slate-950', 'ring-2', 'ring-emerald-400');
    bidButtonText.innerHTML = `<span>✅ HIGHEST BIDDER</span>`;
  } else if (cannotBidReason) {
    btnPlaceBid.disabled = true;
    btnPlaceBid.classList.remove('from-slate-700', 'to-slate-800', 'opacity-50');
    bidStatusNotice.textContent = cannotBidReason;
    bidStatusNotice.classList.remove('hidden');
  } else if (isBidCooldown) {
    btnPlaceBid.disabled = true;
  } else if (hasFolded) {
    // Dynamic Re-entry: Allow placing bid to re-enter
    btnPlaceBid.disabled = false;
    btnPlaceBid.classList.remove('from-emerald-500', 'to-emerald-400', 'text-slate-950', 'ring-2', 'ring-emerald-400');
    btnPlaceBid.classList.add('from-amber-600', 'to-amber-500');
    bidStatusNotice.textContent = 'You passed on this player. Tap BID or UNFOLD to re-enter!';
    bidStatusNotice.classList.remove('hidden');
  } else {
    // Eligible to bid
    btnPlaceBid.disabled = false;
    btnPlaceBid.classList.remove('from-emerald-500', 'to-emerald-400', 'from-slate-700', 'to-slate-800', 'from-amber-600', 'to-amber-500', 'opacity-50', 'text-slate-950', 'ring-2', 'ring-emerald-400');
    btnPlaceBid.classList.add('from-amber-500', 'to-amber-400');
    if (isSoloTesting && currentRoom.highestBidder) {
      const incLabel = inc >= 10000000 ? `+₹${(inc / 10000000).toFixed(2)} Cr` : `+${(inc / 100000).toFixed(0)}L`;
      bidButtonText.innerHTML = `<span>🔨 RAISE BID ${formatCurrency(nextAmount)}</span> <span class="text-xs font-mono font-bold opacity-80">(${incLabel})</span>`;
    }
  }

  // Update Fold button state (Rule 1 & 2: Supports dynamic toggle un-fold)
  if (!myTeam || !currentRoom || !currentRoom.currentPlayer) {
    btnFoldPlayer.disabled = true;
  } else if (isHighestBidder) {
    btnFoldPlayer.disabled = true;
    foldButtonText.textContent = 'LEADING';
    btnFoldPlayer.classList.add('opacity-40');
    btnFoldPlayer.classList.remove('border-emerald-500/50', 'text-emerald-400', 'border-cyan-500/50', 'text-cyan-400');
    btnFoldPlayer.title = 'Highest bidder cannot fold against their own bid!';
  } else {
    const foldedList = currentRoom.foldedTeams || [];
    const hasFolded = foldedList.includes(myTeam.franchiseId);
    btnFoldPlayer.disabled = false;
    if (hasFolded) {
      foldButtonText.textContent = 'UNFOLD ↩️';
      btnFoldPlayer.classList.remove('opacity-40', 'border-emerald-500/50', 'text-emerald-400');
      btnFoldPlayer.classList.add('border-cyan-500/50', 'text-cyan-400');
      btnFoldPlayer.title = 'Click to un-fold and re-enter bidding for this player';
    } else {
      foldButtonText.textContent = 'FOLD';
      btnFoldPlayer.classList.remove('opacity-40', 'border-emerald-500/50', 'text-emerald-400', 'border-cyan-500/50', 'text-cyan-400');
      btnFoldPlayer.title = 'Pass / Fold on this player';
    }
  }

  // Update consensus fold status bar
  const foldedCount = currentRoom.foldedCount || 0;
  const requiredFolds = currentRoom.requiredFolds || (currentRoom.teams ? Math.max(currentRoom.teams.length - 1, 1) : 1);
  if (foldCountDisplay) foldCountDisplay.textContent = `${foldedCount}/${requiredFolds} Teams`;
  if (foldStatusHint) {
    if (foldedCount > 0 && foldedCount < requiredFolds) {
      foldStatusHint.textContent = `${requiredFolds - foldedCount} more needed for instant hammer`;
    } else if (foldedCount >= requiredFolds && requiredFolds > 0) {
      foldStatusHint.textContent = `All teams folded! Hammer falling...`;
    } else {
      foldStatusHint.textContent = `Instant hammer if all pass`;
    }
  }
}

// FOLD BUTTON CLICK HANDLER (Toggle Fold / Un-fold)
btnFoldPlayer.addEventListener('click', () => {
  if (!currentRoom || !currentRoom.currentPlayer || !myTeam) return;

  // Strict client-side guard: highest bidder cannot fold!
  if (currentRoom.highestBidder && (currentRoom.highestBidder.socketId === (socket ? socket.id : null) || currentRoom.highestBidder.teamId === myTeam.franchiseId)) {
    showToast('Illegal action: You are the highest bidder and cannot fold!', 'warning');
    return;
  }

  socket.emit('team_fold', {}, (res) => {
    if (res && res.success) {
      playBeep(res.folded ? 320 : 480, 'sine', 0.15);
      if (!currentRoom.foldedTeams) currentRoom.foldedTeams = [];
      if (res.folded) {
        showToast('You passed on this player!', 'info');
        if (!currentRoom.foldedTeams.includes(myTeam.franchiseId)) {
          currentRoom.foldedTeams.push(myTeam.franchiseId);
        }
        myTeam.isFolded = true;
      } else {
        showToast('You un-folded! You are back in the bidding.', 'success');
        currentRoom.foldedTeams = currentRoom.foldedTeams.filter(id => id !== myTeam.franchiseId);
        myTeam.isFolded = false;
      }
      updateBidButton();
    } else {
      showToast(res ? res.error : 'Cannot toggle fold right now', 'warning');
    }
  });
});

// BID BUTTON CLICK HANDLER
btnPlaceBid.addEventListener('click', () => {
  if (isBidCooldown || !currentRoom || !currentRoom.currentPlayer) return;

  const expectedCurrentBid = currentRoom.currentBid;

  // Tactile micro-shake on physical press
  triggerScreenMicroShake();

  // Pre-emptively clear fold state if user was folded (dynamic re-entry)
  if (myTeam) myTeam.isFolded = false;
  if (currentRoom && currentRoom.foldedTeams) {
    currentRoom.foldedTeams = currentRoom.foldedTeams.filter(id => id !== (myTeam ? myTeam.franchiseId : ''));
  }

  isBidCooldown = true;
  btnPlaceBid.disabled = true;
  setTimeout(() => {
    isBidCooldown = false;
    updateBidButton();
  }, 400);

  socket.emit('place_bid', { expectedCurrentBid }, (res) => {
    isBidCooldown = false;
    if (res && res.success) {
      if (myTeam) myTeam.isFolded = false;
      if (currentRoom && currentRoom.foldedTeams) {
        currentRoom.foldedTeams = currentRoom.foldedTeams.filter(id => id !== (myTeam ? myTeam.franchiseId : ''));
      }
      playBidSound();
      updateBidButton();
    } else {
      playBeep(200, 'sawtooth', 0.25);
      showToast(res ? res.error : 'Bid was rejected', 'error');
      const updatedPrice = res ? (res.serverCurrentBid !== undefined ? res.serverCurrentBid : res.currentBid) : null;
      if (updatedPrice !== null && updatedPrice !== undefined) {
        currentRoom.currentBid = updatedPrice;
        currentBidAmount.textContent = formatCurrency(updatedPrice);
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
    const teamColor = team.color || '#FDB913';
    const card = document.createElement('div');
    card.className = `p-3.5 rounded-2xl border flex flex-col justify-between transition cursor-pointer hover:border-white/30 backdrop-blur-xl relative overflow-hidden ${
      isMe ? 'border-amber-400 bg-gradient-to-r from-amber-500/20 to-[#0e162d]' : 'border-white/10 bg-[#0d1324]/90'
    }`;
    card.style.borderLeft = `5px solid ${teamColor}`;

    card.innerHTML = `
      <div class="flex items-center justify-between mb-2">
        <div class="flex items-center space-x-3">
          <img src="${team.logo || `/logos/${team.franchiseId}.svg`}" alt="${team.franchiseId}" class="w-9 h-9 object-contain filter drop-shadow" />
          <div>
            <div class="text-xs font-black font-display text-white flex items-center space-x-1.5 uppercase tracking-wide">
              <span>${team.name}</span>
              ${isMe ? '<span class="text-[9px] px-1.5 py-0.2 bg-amber-400 text-slate-950 font-black rounded font-mono">YOU</span>' : ''}
            </div>
            <div class="text-[10px] text-slate-400 font-sans">${team.managerName}</div>
          </div>
        </div>
        <div class="text-right">
          <div class="text-sm font-bold font-mono text-victoryEmerald">${formatCurrency(team.purse)}</div>
          <div class="text-[9px] font-display uppercase tracking-widest text-slate-400">Purse Left</div>
        </div>
      </div>
      <div class="flex items-center justify-between text-[10px] pt-2 border-t border-white/10 text-slate-400 font-mono">
        <span>Squad: <b class="text-white">${team.squadCount || 0}/${currentRoom.settings.maxSquadSize}</b></span>
        <span>Points: <b class="text-amber-400 font-display font-bold">★ ${(team.squad || []).reduce((sum, p) => sum + (p.rating || 75), 0)} pts</b></span>
        <div class="flex items-center space-x-1.5">
          ${isHost && !isMe ? `<button class="btn-kick-member px-2 py-0.5 rounded bg-rose-500/20 text-rose-300 hover:bg-rose-500/40 border border-rose-500/40 text-[9px] font-display font-black uppercase tracking-wider" data-team="${team.franchiseId}" data-socket="${team.socketId}" data-player="${team.ownerPlayerId || ''}">KICK</button>` : ''}
          <span class="text-amber-400 hover:text-amber-300 font-display font-bold uppercase tracking-wider">Inspect ➔</span>
        </div>
      </div>
    `;

    // Attach kick listener if present
    const kickBtn = card.querySelector('.btn-kick-member');
    if (kickBtn) {
      kickBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!confirm(`Are you sure you want to kick ${team.managerName} (${team.name}) from the match?`)) return;
        socket.emit('kick_participant', {
          targetPlayerId: kickBtn.dataset.player || null,
          targetSocketId: kickBtn.dataset.socket || null
        }, (res) => {
          if (res && res.success) {
            showToast(`Kicked ${team.managerName}!`, 'info');
          } else {
            showToast(res ? res.error : 'Failed to kick member', 'warning');
          }
        });
      });
    }

    card.addEventListener('click', () => openSquadModal(team));
    drawerTeamsList.appendChild(card);
  });
}

// Squad Details Modal
function openSquadModal(team) {
  modalTeamLogoImg.src = team.logo || `/logos/${team.franchiseId}.svg`;
  modalTeamName.textContent = team.name;
  
  const squad = team.squad || [];
  const totalRating = squad.reduce((sum, p) => sum + (p.rating || 75), 0);
  const avgRating = squad.length > 0 ? (totalRating / squad.length).toFixed(1) : 0;
  
  modalTeamPurse.innerHTML = `
    <span>Purse: <b class="text-victoryEmerald font-mono">${formatCurrency(team.purse)}</b></span>
    <span class="text-slate-600">•</span>
    <span>Squad: <b class="text-white font-mono">${squad.length}/${(currentRoom && currentRoom.settings) ? currentRoom.settings.maxSquadSize : 25}</b></span>
    <span class="text-slate-600">•</span>
    <span>Points: <b class="text-amber-400 font-mono font-bold">${totalRating} pts (Avg: ${avgRating})</b></span>
  `;

  modalSquadList.innerHTML = '';
  if (squad.length === 0) {
    modalSquadList.innerHTML = '<div class="text-center py-8 text-xs text-slate-500 font-sans">No players acquired yet in this auction.</div>';
  } else {
    squad.forEach((player, i) => {
      const rating = player.rating || 75;
      const ratingColor = rating >= 90 ? 'bg-amber-400 text-slate-950' : rating >= 80 ? 'bg-cyan-500/20 text-laserCyan border border-cyan-400/40' : 'bg-slate-800 text-slate-300';
      const row = document.createElement('div');
      row.className = 'p-3 rounded-2xl bg-[#090e1f] border border-white/10 flex items-center justify-between text-xs hover:border-white/20 transition';
      row.innerHTML = `
        <div class="flex items-center space-x-3">
          <span class="text-slate-500 font-mono font-bold w-5">${i + 1}.</span>
          <img src="${player.photo}" alt="${player.name}" class="w-9 h-9 rounded-xl object-cover object-top border border-white/15" onerror="this.src='/icons/player_avatar.svg'" />
          <div>
            <div class="font-black font-display text-white flex items-center space-x-1.5 uppercase tracking-wide">
              <span>${player.name}</span>
              <span class="text-[10px] px-1.5 py-0.5 rounded-full font-black font-display ${ratingColor}">★ ${rating}</span>
              ${player.isOverseas ? '<span class="text-[9px] px-1 rounded bg-blue-500/30 text-laserCyan font-mono">OS</span>' : ''}
              ${player.acquiredVia === 'RETENTION' ? '<span class="text-[9px] px-1 rounded bg-amber-500/25 text-amber-300 font-display font-bold">RETAINED</span>' : ''}
            </div>
            <div class="text-[10px] text-slate-400 font-sans">${player.role} • ${player.country}</div>
          </div>
        </div>
        <div class="font-mono font-bold text-amber-400 text-sm text-right">
          ${formatCurrency(player.finalPrice)}
        </div>
      `;
      modalSquadList.appendChild(row);
    });
  }

  squadModal.classList.remove('hidden');
}

closeSquadModalBtn.addEventListener('click', () => squadModal.classList.add('hidden'));

// Drawers Toggle (Desktop vs Mobile Bottom Sheet)
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

// =========================================================================
// MOBILE BOTTOM SHEET CONTROLLER & ACCORDION LEADERBOARD (Screens <= 768px)
// =========================================================================
const mobileSheetBackdrop = document.getElementById('mobileSheetBackdrop');
const mobileBottomSheet = document.getElementById('mobileBottomSheet');
const mobileSheetDragHandle = document.getElementById('mobileSheetDragHandle');
const closeMobileSheetBtn = document.getElementById('closeMobileSheetBtn');
const mobileSheetContent = document.getElementById('mobileSheetContent');

function openMobileBottomSheet() {
  if (!mobileBottomSheet || !mobileSheetBackdrop) return;
  mobileSheetBackdrop.classList.remove('hidden');
  mobileBottomSheet.classList.remove('hidden');
  requestAnimationFrame(() => {
    mobileBottomSheet.classList.add('open');
  });
  renderMobileSheetStandings();
}

function closeMobileBottomSheet() {
  if (!mobileBottomSheet) return;
  mobileBottomSheet.classList.remove('open');
  setTimeout(() => {
    if (mobileBottomSheet) mobileBottomSheet.classList.add('hidden');
    if (mobileSheetBackdrop) mobileSheetBackdrop.classList.add('hidden');
  }, 320);
}

if (closeMobileSheetBtn) closeMobileSheetBtn.addEventListener('click', closeMobileBottomSheet);
if (mobileSheetBackdrop) mobileSheetBackdrop.addEventListener('click', closeMobileBottomSheet);

// Touch Swipe-Down Gesture to Dismiss Bottom Sheet
if (mobileSheetDragHandle) {
  let touchStartY = 0;
  mobileSheetDragHandle.addEventListener('touchstart', (e) => {
    touchStartY = e.touches[0].clientY;
  }, { passive: true });

  mobileSheetDragHandle.addEventListener('touchmove', (e) => {
    const currentY = e.touches[0].clientY;
    const diff = currentY - touchStartY;
    if (diff > 50) {
      closeMobileBottomSheet();
    }
  }, { passive: true });
}

function renderMobileSheetStandings() {
  if (!mobileSheetContent || !currentRoom) return;
  mobileSheetContent.innerHTML = '';

  const teams = (currentRoom.standings && currentRoom.standings.length > 0)
    ? currentRoom.standings 
    : (currentRoom.teams || []);

  if (teams.length === 0) {
    mobileSheetContent.innerHTML = '<div class="text-center py-8 text-xs text-slate-500 font-sans">No franchises claimed in this room yet.</div>';
    return;
  }

  teams.forEach((team, index) => {
    const teamId = team.franchiseId || team.teamId || team.id;
    const teamName = team.teamName || team.name || teamId;
    const teamLogo = team.logo || `/logos/${teamId}.svg`;
    const purse = team.remainingPurse !== undefined ? team.remainingPurse : (team.purse || 0);
    const squad = team.squad || [];
    const totalPoints = team.totalPoints !== undefined ? team.totalPoints : squad.reduce((sum, p) => sum + (p.rating || 75), 0);
    const rank = team.rank || (index + 1);
    const isMe = myTeam && myTeam.franchiseId === teamId;

    const card = document.createElement('div');
    card.className = `p-3 rounded-2xl border transition bg-[#0d1324] ${
      isMe ? 'border-amber-400/80 bg-amber-500/10' : 'border-white/10'
    }`;

    card.innerHTML = `
      <div class="flex items-center justify-between cursor-pointer mobile-team-row">
        <div class="flex items-center space-x-2.5">
          <span class="font-mono font-bold text-xs ${rank === 1 ? 'text-amber-400 font-black' : rank === 2 ? 'text-slate-300 font-bold' : rank === 3 ? 'text-amber-600 font-bold' : 'text-slate-500'}">#${rank}</span>
          <img src="${teamLogo}" alt="${teamId}" class="w-8 h-8 object-contain filter drop-shadow" />
          <div>
            <div class="font-display font-black text-xs text-white uppercase flex items-center space-x-1.5">
              <span>${teamName}</span>
              ${isMe ? '<span class="text-[9px] px-1 py-0.2 rounded bg-amber-400 text-slate-950 font-black">YOU</span>' : ''}
            </div>
            <div class="text-[10px] text-slate-400 font-sans">${team.managerName || 'Manager'}</div>
          </div>
        </div>
        <div class="text-right flex items-center space-x-2">
          <div>
            <div class="font-mono font-bold text-amber-400 text-xs">★ ${totalPoints} pts</div>
            <div class="font-mono text-[10px] text-victoryEmerald font-semibold">${formatCurrency(purse)}</div>
          </div>
          ${isHost && !isMe ? `<button class="btn-kick-member-mobile px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-300 border border-rose-500/40 text-[9px] font-display font-black uppercase tracking-wider" data-team="${teamId}" data-socket="${team.socketId || ''}" data-player="${team.ownerPlayerId || ''}">KICK</button>` : ''}
          <i class="fa-solid fa-chevron-down text-slate-500 text-xs accordion-arrow transition-transform"></i>
        </div>
      </div>
      <div class="mobile-squad-accordion hidden mt-2.5 pt-2.5 border-t border-white/10 space-y-1.5">
        ${squad.length === 0 ? '<div class="text-[11px] text-slate-500 py-1">No players signed yet.</div>' : squad.map((p, idx) => `
          <div class="flex items-center justify-between text-[11px] py-1 border-b border-white/5 last:border-b-0">
            <div class="flex items-center space-x-2 truncate">
              <span class="text-slate-500 font-mono text-[10px] w-4">${idx + 1}.</span>
              <span class="font-semibold text-white truncate max-w-[140px]">${p.name}</span>
              <span class="text-[9px] px-1.5 py-0.2 rounded font-bold font-display ${p.rating >= 90 ? 'bg-amber-400 text-slate-950 font-black' : 'bg-cyan-500/20 text-laserCyan'}">★ ${p.rating || 75}</span>
            </div>
            <span class="font-mono font-bold text-amber-400 text-[10px]">${formatCurrency(p.finalPrice || p.basePrice || 0)}</span>
          </div>
        `).join('')}
      </div>
    `;

    // Toggle squad accordion
    const headerRow = card.querySelector('.mobile-team-row');
    const accordion = card.querySelector('.mobile-squad-accordion');
    const arrow = card.querySelector('.accordion-arrow');
    headerRow.addEventListener('click', (e) => {
      if (e.target.closest('.btn-kick-member-mobile')) return;
      const isHidden = accordion.classList.contains('hidden');
      if (isHidden) {
        accordion.classList.remove('hidden');
        arrow.classList.add('rotate-180');
      } else {
        accordion.classList.add('hidden');
        arrow.classList.remove('rotate-180');
      }
    });

    const mobileKickBtn = card.querySelector('.btn-kick-member-mobile');
    if (mobileKickBtn) {
      mobileKickBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!confirm(`Are you sure you want to kick ${team.managerName || teamName} from the match?`)) return;
        socket.emit('kick_participant', {
          targetPlayerId: mobileKickBtn.dataset.player || null,
          targetSocketId: mobileKickBtn.dataset.socket || null
        }, (res) => {
          if (res && res.success) {
            showToast(`Kicked member!`, 'info');
          } else {
            showToast(res ? res.error : 'Failed to kick member', 'warning');
          }
        });
      });
    }

    mobileSheetContent.appendChild(card);
  });
}

function populateModalStandings() {
  const container = document.getElementById('modal-standings-content');
  if (!container || !currentRoom) return;
  container.innerHTML = '';

  const teams = (currentRoom.standings && currentRoom.standings.length > 0)
    ? currentRoom.standings 
    : (currentRoom.teams || []);

  if (teams.length === 0) {
    container.innerHTML = '<div class="text-center py-8 text-xs text-slate-500 font-sans">No franchises claimed in this room yet.</div>';
    return;
  }

  teams.forEach((team, index) => {
    const teamId = team.franchiseId || team.teamId || team.id;
    const teamName = team.teamName || team.name || teamId;
    const teamLogo = team.logo || `/logos/${teamId}.svg`;
    const purse = team.remainingPurse !== undefined ? team.remainingPurse : (team.purse || 0);
    const squad = team.squad || [];
    const totalPoints = team.totalPoints !== undefined ? team.totalPoints : squad.reduce((sum, p) => sum + (p.rating || 75), 0);
    const rank = team.rank || (index + 1);
    const isMe = myTeam && myTeam.franchiseId === teamId;

    const card = document.createElement('div');
    card.className = `p-3 rounded-2xl border transition bg-[#0d1324] ${
      isMe ? 'border-amber-400/80 bg-amber-500/10' : 'border-white/10'
    }`;

    card.innerHTML = `
      <div class="flex items-center justify-between cursor-pointer modal-team-row">
        <div class="flex items-center space-x-2.5">
          <span class="font-mono font-bold text-xs ${rank === 1 ? 'text-amber-400 font-black' : rank === 2 ? 'text-slate-300 font-bold' : rank === 3 ? 'text-amber-600 font-bold' : 'text-slate-500'}">#${rank}</span>
          <img src="${teamLogo}" alt="${teamId}" class="w-8 h-8 object-contain filter drop-shadow" />
          <div>
            <div class="font-display font-black text-xs text-white uppercase flex items-center space-x-1.5">
              <span>${teamName}</span>
              ${isMe ? '<span class="text-[9px] px-1 py-0.2 rounded bg-amber-400 text-slate-950 font-black">YOU</span>' : ''}
            </div>
            <div class="text-[10px] text-slate-400 font-sans">${team.managerName || 'Manager'}</div>
          </div>
        </div>
        <div class="text-right flex items-center space-x-2">
          <div>
            <div class="font-mono font-bold text-amber-400 text-xs">★ ${totalPoints} pts</div>
            <div class="font-mono text-[10px] text-victoryEmerald font-semibold">${formatCurrency(purse)}</div>
          </div>
          <i class="fa-solid fa-chevron-down text-slate-500 text-xs accordion-arrow transition-transform"></i>
        </div>
      </div>
      <div class="modal-squad-accordion hidden mt-2.5 pt-2.5 border-t border-white/10 space-y-1.5">
        ${squad.length === 0 ? '<div class="text-[11px] text-slate-500 py-1">No players signed yet.</div>' : squad.map((p, idx) => `
          <div class="flex items-center justify-between text-[11px] py-1 border-b border-white/5 last:border-b-0">
            <div class="flex items-center space-x-2 truncate">
              <span class="text-slate-500 font-mono text-[10px] w-4">${idx + 1}.</span>
              <span class="font-semibold text-white truncate max-w-[140px]">${p.name}</span>
              <span class="text-[9px] px-1.5 py-0.2 rounded font-bold font-display ${p.rating >= 90 ? 'bg-amber-400 text-slate-950 font-black' : 'bg-cyan-500/20 text-laserCyan'}">★ ${p.rating || 75}</span>
            </div>
            <span class="font-mono font-bold text-amber-400 text-[10px]">${formatCurrency(p.finalPrice || p.basePrice || 0)}</span>
          </div>
        `).join('')}
      </div>
    `;

    // Toggle squad accordion
    const headerRow = card.querySelector('.modal-team-row');
    const accordion = card.querySelector('.modal-squad-accordion');
    const arrow = card.querySelector('.accordion-arrow');
    headerRow.addEventListener('click', () => {
      const isHidden = accordion.classList.contains('hidden');
      if (isHidden) {
        accordion.classList.remove('hidden');
        arrow.classList.add('rotate-180');
      } else {
        accordion.classList.add('hidden');
        arrow.classList.remove('rotate-180');
      }
    });

    container.appendChild(card);
  });
}

toggleDrawerBtn.addEventListener('click', () => {
  if (window.innerWidth <= 768) {
    openMobileBottomSheet();
  } else {
    if (teamsDrawer.classList.contains('translate-x-full')) {
      openTeamsDrawer();
    } else {
      closeTeamsDrawer();
    }
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

// =========================================================================
// SPECTATOR FAN DECK CONTROLLER & CHEER REACTION MECHANICS
// =========================================================================
const managerActionDock = document.getElementById('manager-dock-controls') || document.getElementById('managerActionDock');
const spectatorFanDeck = document.getElementById('spectator-dock-controls') || document.getElementById('spectatorFanDeck');
const spectatorAllegianceName = document.getElementById('spectator-allegiance-name') || document.getElementById('spectatorAllegianceName');
const cheerTeamTag = document.getElementById('cheerTeamTag');
const decibelFill = document.getElementById('decibelFill');
const decibelValueText = document.getElementById('decibelValueText');
const allegiancePickerBar = document.getElementById('allegiancePickerBar');
const cheerReactionContainer = document.getElementById('cheerReactionContainer');

function setupSpectatorUI() {
  const mDock = document.getElementById('manager-dock-controls');
  const sDeck = document.getElementById('spectator-dock-controls');
  if (mDock) mDock.classList.add('hidden');
  if (sDeck) {
    sDeck.classList.remove('hidden');
    sDeck.classList.add('flex');
  }

  const headerTeamBadge = document.getElementById('header-team-badge');
  const headerPurseVal = document.getElementById('header-purse-val');
  if (headerTeamBadge) headerTeamBadge.textContent = 'FAN';
  if (headerPurseVal) headerPurseVal.textContent = 'Spectator';

  const desktopTeamBadge = document.getElementById('desktop-team-badge');
  const desktopPurseVal = document.getElementById('desktop-purse-val');
  const desktopTeamLogo = document.getElementById('desktop-team-logo');
  if (desktopTeamBadge) desktopTeamBadge.textContent = 'SPECTATOR';
  if (desktopPurseVal) desktopPurseVal.textContent = 'Fan Deck';
  if (desktopTeamLogo) desktopTeamLogo.src = '/icons/player_avatar.svg';

  if (userFranchisePill) {
    userFranchisePill.classList.remove('hidden');
    userFranchisePill.classList.add('flex');
    userFranchisePill.className = 'flex items-center space-x-2 px-3 py-1 rounded-xl bg-[#08152e] border border-cyan-400/50 text-xs shadow-lg shadow-cyan-500/20';
  }
  if (userFranchiseLogo) userFranchiseLogo.src = '/icons/player_avatar.svg';
  if (userFranchiseTag) userFranchiseTag.textContent = 'SPECTATOR';
  if (userPurseDisplay) userPurseDisplay.textContent = 'Fan Deck';

  renderAllegiancePicker();
}

function setupManagerUI() {
  const mDock = document.getElementById('manager-dock-controls');
  const sDeck = document.getElementById('spectator-dock-controls');
  if (sDeck) {
    sDeck.classList.add('hidden');
    sDeck.classList.remove('flex');
  }
  if (mDock) {
    mDock.classList.remove('hidden');
    mDock.classList.add('flex');
  }
  updateUserFranchisePill();
}

function updateSpectatorButtonLabels() {
  const isSpec = (currentRole === 'spectator');
  const modalBtn = document.getElementById('btnToggleSpectatorModal');
  const modalDesc = document.getElementById('modalRoleDesc');
  const lobbyBtnText = document.getElementById('btnSwitchToSpectatorLobbyText');
  const desktopBtnText = document.getElementById('desktopSpectatorBtnText');
  const mobileBtnText = document.getElementById('mobileSpectatorBtnText');

  if (modalBtn) modalBtn.textContent = isSpec ? 'Switch to Manager' : 'Switch to Spectator';
  if (modalDesc) modalDesc.textContent = isSpec ? 'Current: Spectator' : 'Current: Manager';
  if (lobbyBtnText) lobbyBtnText.textContent = isSpec ? 'Claim Franchise' : 'Watch as Spectator';
  if (desktopBtnText) desktopBtnText.textContent = isSpec ? 'Manage' : 'Spectate';
  if (mobileBtnText) mobileBtnText.textContent = isSpec ? 'Manage' : 'Spectator';
}

function switchUserRole(targetRole) {
  if (!currentRoom) return;
  const newRole = targetRole || (currentRole === 'spectator' ? 'manager' : 'spectator');
  socket.emit('switch_role', { role: newRole }, (res) => {
    if (res && res.success) {
      currentRole = res.role;
      showToast(`Switched to ${currentRole === 'spectator' ? 'Spectator Mode 👓' : 'Manager Mode 🔨'}!`, 'info');
      if (currentRole === 'spectator') {
        setupSpectatorUI();
      } else {
        setupManagerUI();
      }
      updateSpectatorButtonLabels();
    } else {
      showToast(res ? res.error : 'Failed to switch role', 'error');
    }
  });
}

// Wire spectator role switch buttons
[btnSwitchToSpectatorLobby, btnToggleSpectatorAuction, btnToggleSpectatorDesktop, btnToggleSpectatorModal].forEach(btn => {
  if (btn) {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      switchUserRole();
    });
  }
});

function renderAllegiancePicker() {
  if (!allegiancePickerBar) return;
  allegiancePickerBar.innerHTML = '';

  FRANCHISES.forEach(f => {
    const isSelected = currentAllegiance === f.id;
    const pill = document.createElement('button');
    pill.className = `px-2.5 py-1 rounded-lg text-[10px] font-black font-display uppercase tracking-wider flex items-center space-x-1.5 transition active:scale-95 flex-shrink-0 ${
      isSelected 
        ? 'bg-amber-400 text-slate-950 shadow-md shadow-amber-400/30 ring-1 ring-white' 
        : 'bg-[#0e172e] text-slate-300 border border-white/10 hover:border-white/20'
    }`;
    pill.innerHTML = `
      <img src="${f.logo}" alt="${f.id}" class="w-3.5 h-3.5 object-contain" />
      <span>${f.id}</span>
    `;
    pill.addEventListener('click', () => {
      currentAllegiance = f.id;
      if (spectatorAllegianceName) spectatorAllegianceName.textContent = f.name;
      if (cheerTeamTag) cheerTeamTag.textContent = f.id;
      setFranchiseAura(f.id);
      renderAllegiancePicker();
      showToast(`Rooting for ${f.name}!`, 'info');
    });
    allegiancePickerBar.appendChild(pill);
  });
}

function spawnFloatingCheerSprite(emoji) {
  if (!cheerReactionContainer) return;
  const sprite = document.createElement('div');
  sprite.className = 'floating-cheer-sprite text-2xl sm:text-4xl';
  sprite.textContent = emoji || '👏';
  
  const randomX = Math.floor(15 + Math.random() * 70);
  sprite.style.left = `${randomX}%`;
  sprite.style.bottom = `${80 + Math.random() * 60}px`;

  cheerReactionContainer.appendChild(sprite);
  setTimeout(() => sprite.remove(), 2300);
}

function triggerLightningArc() {
  const overlay = document.createElement('div');
  overlay.className = 'lightning-arc-effect';
  document.body.appendChild(overlay);
  setTimeout(() => overlay.remove(), 650);
}

function playCheerSound(type) {
  if (type === 'horn') {
    playBeep(440, 'sawtooth', 0.15);
    setTimeout(() => playBeep(554.37, 'sawtooth', 0.25), 80);
  } else if (type === 'fire') {
    playBeep(110, 'square', 0.3);
  } else if (type === 'applause') {
    playBeep(523.25, 'sine', 0.08);
    setTimeout(() => playBeep(659.25, 'sine', 0.08), 50);
    setTimeout(() => playBeep(783.99, 'sine', 0.08), 100);
  } else if (type === 'lightning') {
    playBeep(987.77, 'sawtooth', 0.1);
    setTimeout(() => playBeep(1318.51, 'square', 0.15), 60);
  } else if (type === 'chant') {
    playBeep(523.25, 'triangle', 0.12);
    setTimeout(() => playBeep(659.25, 'triangle', 0.12), 120);
    setTimeout(() => playBeep(783.99, 'triangle', 0.2), 240);
  }
}

// Wire Cheer Buttons
document.querySelectorAll('.cheer-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const cheerType = btn.dataset.cheer || 'applause';
    const emoji = btn.dataset.emoji || '👏';

    playCheerSound(cheerType);
    spawnFloatingCheerSprite(emoji);
    if (cheerType === 'lightning') triggerLightningArc();

    if (socket && socket.connected) {
      socket.emit('spectator_cheer', {
        teamId: currentAllegiance,
        cheerType,
        cheerEmoji: emoji
      });
    }
  });
});

// Community Prediction Poll Buttons
const btnVoteSold = document.getElementById('btnVoteSold');
const btnVoteUnsold = document.getElementById('btnVoteUnsold');
if (btnVoteSold) {
  btnVoteSold.addEventListener('click', () => {
    btnVoteSold.classList.add('bg-emerald-500/30', 'font-black');
    if (btnVoteUnsold) btnVoteUnsold.classList.remove('bg-rose-500/30', 'font-black');
    showToast('Prediction recorded: SOLD! 🏏', 'info');
    spawnFloatingCheerSprite('💰');
  });
}
if (btnVoteUnsold) {
  btnVoteUnsold.addEventListener('click', () => {
    btnVoteUnsold.classList.add('bg-rose-500/30', 'font-black');
    if (btnVoteSold) btnVoteSold.classList.remove('bg-emerald-500/30', 'font-black');
    showToast('Prediction recorded: UNSOLD! ❌', 'info');
    spawnFloatingCheerSprite('❌');
  });
}

btnViewFinalSquads.addEventListener('click', openTeamsDrawer);

// LIVE MATCH ACTIVITY WIRE (Non-Intrusive Broadcast Activity Engine)
function updateMatchActivityWire(message, type = 'info') {
  const wire = document.getElementById('matchActivityWire');
  const badge = document.getElementById('activityTagBadge');
  const tagText = document.getElementById('activityTagText');
  const msgText = document.getElementById('liveFeedTicker');
  if (!msgText || !message) return;

  const typeConfig = {
    sold: {
      tag: 'HAMMER SOLD',
      badgeClass: 'bg-emerald-600 text-white border-emerald-400 shadow-emerald-600/30'
    },
    unsold: {
      tag: 'UNSOLD',
      badgeClass: 'bg-rose-700 text-white border-rose-500 shadow-rose-700/30'
    },
    bid: {
      tag: 'NEW BID',
      badgeClass: 'bg-amber-500 text-slate-950 font-black border-amber-300 shadow-amber-500/30'
    },
    lot: {
      tag: 'ON HAMMER',
      badgeClass: 'bg-cyan-600 text-white border-cyan-400 shadow-cyan-600/30'
    },
    announcement: {
      tag: 'ARENA',
      badgeClass: 'bg-indigo-600 text-white border-indigo-400 shadow-indigo-600/30'
    },
    warning: {
      tag: 'NOTICE',
      badgeClass: 'bg-amber-600 text-white border-amber-400 shadow-amber-600/30'
    },
    info: {
      tag: 'LIVE WIRE',
      badgeClass: 'bg-rose-600 text-white border-rose-400 shadow-rose-600/30'
    }
  };

  const cfg = typeConfig[type] || typeConfig.info;
  if (tagText) tagText.textContent = cfg.tag;
  if (badge) {
    badge.className = `px-2 py-0.5 rounded-md text-[9px] sm:text-[10px] font-black font-display uppercase tracking-wider flex-shrink-0 flex items-center gap-1 shadow-sm border ${cfg.badgeClass}`;
  }
  msgText.textContent = message;

  if (wire) {
    wire.classList.remove('activity-flash-active');
    void wire.offsetWidth; // re-flow
    wire.classList.add('activity-flash-active');
  }
}

// Hook wire click to open logs drawer
const btnOpenLogsFromWire = document.getElementById('btnOpenLogsFromWire');
if (btnOpenLogsFromWire) {
  btnOpenLogsFromWire.addEventListener('click', (e) => {
    e.stopPropagation();
    openLogsDrawer();
  });
}
const matchActivityWire = document.getElementById('matchActivityWire');
if (matchActivityWire) {
  matchActivityWire.addEventListener('click', () => {
    openLogsDrawer();
  });
}

// Broadcast Event Feed update
function renderLogEntry(entry) {
  if (!entry || !entry.message) return;
  const row = document.createElement('div');
  
  const typeIcons = {
    sold: '<i class="fa-solid fa-trophy text-victoryEmerald mr-1.5"></i>',
    unsold: '<i class="fa-solid fa-circle-xmark text-laserCrimson mr-1.5"></i>',
    bid: '<i class="fa-solid fa-gavel text-amber-400 mr-1.5"></i>',
    announcement: '<i class="fa-solid fa-bullhorn text-laserCyan mr-1.5"></i>',
    warning: '<i class="fa-solid fa-triangle-exclamation text-amber-400 mr-1.5"></i>',
    finish: '<i class="fa-solid fa-flag-checkered text-amber-300 mr-1.5"></i>'
  };

  const typeBorders = {
    sold: 'border-l-4 border-victoryEmerald bg-[#09161a]',
    unsold: 'border-l-4 border-laserCrimson bg-[#160b12]',
    bid: 'border-l-4 border-amber-400 bg-[#161208]',
    announcement: 'border-l-4 border-laserCyan bg-[#08151f]',
    warning: 'border-l-4 border-amber-500 bg-[#141209]',
    finish: 'border-l-4 border-yellow-400 bg-[#161408]'
  };

  row.className = `p-2.5 rounded-xl border border-white/5 my-1 text-xs transition duration-200 ${typeBorders[entry.type] || 'bg-[#080d1e]'}`;
  row.innerHTML = `
    <div class="flex items-center justify-between text-[10px] text-slate-500 mb-0.5">
      <span class="font-mono">${entry.time || ''}</span>
      <span class="font-display font-bold uppercase tracking-wider text-slate-400">${entry.type || 'INFO'}</span>
    </div>
    <div class="font-sans text-slate-200 leading-snug">
      ${typeIcons[entry.type] || ''}${entry.message}
    </div>
  `;

  if (fullLogsFeed) fullLogsFeed.prepend(row);
  updateMatchActivityWire(entry.message, entry.type);
}


// Wire up Host Conclude Elements

const auctionConcludingBanner = document.getElementById('auctionConcludingBanner');
const auctionConcludingText = document.getElementById('auctionConcludingText');
const btnHostConcludeAuction = document.getElementById('btnHostConcludeAuction');

if (btnHostConcludeAuction) {
  btnHostConcludeAuction.addEventListener('click', () => {
    if (!currentRoom || !isHost) return;
    const minSquad = (currentRoom.settings && currentRoom.settings.minSquadSize) || 15;
    const shortTeam = (currentRoom.teams || []).find(t => (t.squadCount || t.squad.length) < minSquad);
    if (shortTeam) {
      showToast(`Cannot conclude: ${shortTeam.name} has fewer than ${minSquad} players (${shortTeam.squadCount || shortTeam.squad.length}/${minSquad}).`, 'warning');
      return;
    }
    if (!confirm('Conclude auction early and finalize official championship standings?')) return;
    socket.emit('host_conclude_auction', {}, (res) => {
      if (res && res.success) {
        showToast('Auction concluded by Host! Standings finalizing...', 'info');
      } else {
        showToast(res ? res.error : 'Cannot conclude auction yet', 'warning');
      }
    });
  });
}

// Return Home from Podium handler
const btnReturnHomeFromPodium = document.getElementById('btnReturnHomeFromPodium');
if (btnReturnHomeFromPodium) {
  btnReturnHomeFromPodium.addEventListener('click', () => {
    performSessionCleanupBeforeNewMatch();
    showView('home');
    showToast('Returned to Home Gateway. Previous session cleared.', 'info');
  });
}

// OLYMPIC PODIUM & LEADERBOARD SYSTEM (0–100 Standardized Rating Engine)
const podiumTop3Container = document.getElementById('podiumTop3Container');
const podiumRestTableBody = document.getElementById('podiumRestTableBody');
const celebratedPodiumRooms = new Set();

function renderPodium(standings) {
  if (!standings || !Array.isArray(standings) || standings.length === 0) {
    if (currentRoom && currentRoom.teams) {
      standings = currentRoom.teams.map(t => {
        const squad = t.squad || [];
        const totalPoints = squad.reduce((sum, p) => sum + (p.rating || 75), 0);
        return {
          rank: 0,
          teamId: t.franchiseId,
          teamName: t.name,
          managerName: t.managerName,
          logo: t.logo || `/logos/${t.franchiseId}.svg`,
          color: t.color || '#334155',
          squadCount: squad.length,
          remainingPurse: t.purse,
          totalPoints,
          squad
        };
      }).sort((a, b) => (b.totalPoints - a.totalPoints) || (b.remainingPurse - a.remainingPurse));
      standings.forEach((s, idx) => s.rank = idx + 1);
    } else {
      return;
    }
  }

  showView('podium');

  const top3 = standings.slice(0, 3);
  const rest = standings.slice(3);

  // Trigger celebration effects ONLY ONCE per room session for this client
  const currentRoomCode = (currentRoom && currentRoom.code) ? currentRoom.code : 'active_room';
  if (!celebratedPodiumRooms.has(currentRoomCode)) {
    celebratedPodiumRooms.add(currentRoomCode);

    if (typeof confetti === 'function') {
      confetti({ particleCount: 220, spread: 120, origin: { y: 0.55 } });
      setTimeout(() => {
        confetti({ particleCount: 150, angle: 60, spread: 70, origin: { x: 0.1, y: 0.6 } });
        confetti({ particleCount: 150, angle: 120, spread: 70, origin: { x: 0.9, y: 0.6 } });
      }, 450);
    }

    const champion = top3[0];
    if (champion) {
      speakCommentary(`Congratulations to ${champion.teamName} and Manager ${champion.managerName} for clinching the IPL Mega Auction Championship title!`);
    }
  }

  // Helper to reliably get franchise metadata (prevent undefined)
  const getTeamName = (t) => t.teamName || t.name || (FRANCHISES.find(f => f.id === (t.teamId || t.franchiseId)) || {}).name || t.teamId || t.franchiseId || 'Franchise';
  const getTeamTag = (t) => t.teamId || t.franchiseId || 'IPL';
  const getTeamLogo = (t) => t.logo || `/logos/${getTeamTag(t)}.svg`;
  const getTeamPurse = (t) => (t.remainingPurse !== undefined && !isNaN(t.remainingPurse)) ? t.remainingPurse : (t.purse !== undefined && !isNaN(t.purse) ? t.purse : 0);

  // Render Top 3 Podium (Responsive: Vertical Tier on Mobile, 3-Col Olympic on Desktop)
  if (podiumTop3Container) {
    podiumTop3Container.innerHTML = '';

    const first = top3[0];
    const second = top3[1];
    const third = top3[2];

    const tag1 = first ? getTeamTag(first) : null;
    const name1 = first ? getTeamName(first) : '';
    const logo1 = first ? getTeamLogo(first) : '';
    const purse1 = first ? getTeamPurse(first) : 0;

    const tag2 = second ? getTeamTag(second) : null;
    const name2 = second ? getTeamName(second) : '';
    const logo2 = second ? getTeamLogo(second) : '';
    const purse2 = second ? getTeamPurse(second) : 0;

    const tag3 = third ? getTeamTag(third) : null;
    const name3 = third ? getTeamName(third) : '';
    const logo3 = third ? getTeamLogo(third) : '';
    const purse3 = third ? getTeamPurse(third) : 0;

    podiumTop3Container.innerHTML = `
      <div class="w-full max-w-4xl flex flex-col md:flex-row items-center md:items-end justify-center gap-3 sm:gap-6">
        
        <!-- RANK 1 CARD (TOP FULL-WIDTH ON MOBILE, CENTER ELEVATED ON DESKTOP) -->
        ${first ? `
        <div class="w-full md:flex-1 md:max-w-[310px] md:order-2 z-10 flex flex-col items-center champion-reveal-anim">
          <div class="crown-float text-amber-400 text-3xl sm:text-4xl mb-1 filter drop-shadow-[0_0_15px_rgba(255,184,0,0.85)]">
            <i class="fa-solid fa-crown"></i>
          </div>
          <div class="w-20 h-20 sm:w-24 sm:h-24 rounded-3xl p-2.5 bg-gradient-to-b from-amber-500/30 to-[#0e1838] border-2 border-amber-400 shadow-2xl shadow-amber-500/40 mb-2 flex items-center justify-center relative">
            <span class="absolute -top-3.5 -right-2.5 w-8 h-8 rounded-full bg-gradient-to-tr from-amber-400 to-yellow-300 text-slate-950 font-black font-display text-sm flex items-center justify-center shadow-2xl border-2 border-white">1</span>
            <img src="${logo1}" alt="${tag1}" class="w-full h-full object-contain filter drop-shadow-xl" />
          </div>
          <div class="font-display font-black text-lg sm:text-xl text-amber-300 uppercase tracking-wider gold-foil-text text-center">${name1}</div>
          <div class="text-xs sm:text-sm text-slate-300 font-sans truncate max-w-full font-bold mb-2">${first.managerName || 'Manager'} (${tag1})</div>

          <div class="w-full rounded-3xl pedestal-gold p-4 sm:p-5 flex flex-col justify-between items-center text-center cursor-pointer hover:scale-[1.02] transition shadow-2xl border border-amber-400/50" onclick="inspectTeamById('${tag1}')">
            <div class="px-3 py-0.5 rounded-full bg-amber-400 text-slate-950 text-[10px] sm:text-xs font-black font-display tracking-widest uppercase shadow">
              🏆 CHAMPION
            </div>
            <div class="my-3">
              <div class="text-3xl sm:text-5xl font-black font-display text-white tracking-tight text-glow-gold">${first.totalPoints}</div>
              <div class="text-xs font-display uppercase tracking-wider text-amber-200/90 font-bold">Total Squad Points</div>
            </div>
            <div class="w-full flex items-center justify-center gap-3 text-xs font-mono font-bold pt-2 border-t border-amber-400/20">
              <span class="text-victoryEmerald">Purse: ${formatCurrency(purse1)}</span>
              <span class="text-slate-500">•</span>
              <span class="text-slate-300">${first.squadCount || (first.squad ? first.squad.length : 0)} Players</span>
            </div>
          </div>
        </div>
        ` : ''}

        <!-- RUNNER-UP CARDS: 2-COLUMN GRID ON MOBILE (<768px), DESKTOP PARTICIPANTS IN 3-COL ROW -->
        <div class="w-full grid grid-cols-2 gap-3 md:contents">
          <!-- RANK 2 CARD (SILVER) -->
          ${second ? `
          <div class="w-full md:flex-1 md:max-w-[260px] md:order-1 flex flex-col items-center">
            <div class="w-14 h-14 sm:w-20 sm:h-20 rounded-2xl p-2 bg-[#0a1024] border-2 border-slate-300 shadow-xl mb-1.5 flex items-center justify-center relative">
              <span class="absolute -top-2.5 -right-2 w-6 h-6 sm:w-7 sm:h-7 rounded-full bg-slate-300 text-slate-950 font-black font-display text-xs flex items-center justify-center shadow-lg border border-white">2</span>
              <img src="${logo2}" alt="${tag2}" class="w-full h-full object-contain filter drop-shadow" />
            </div>
            <div class="font-display font-black text-xs sm:text-base text-white uppercase tracking-wider text-center truncate max-w-full">${name2}</div>
            <div class="text-[10px] sm:text-xs text-slate-400 font-sans truncate max-w-full mb-1.5">${second.managerName || 'Manager'} (${tag2})</div>

            <div class="w-full rounded-2xl sm:rounded-3xl pedestal-silver p-3 sm:p-4 flex flex-col justify-between items-center text-center cursor-pointer hover:scale-[1.02] transition shadow-xl" onclick="inspectTeamById('${tag2}')">
              <div class="text-[9px] sm:text-[10px] font-display font-bold tracking-widest text-slate-300 uppercase">RUNNER UP</div>
              <div class="my-2">
                <div class="text-xl sm:text-3xl font-black font-display text-white tracking-tight">${second.totalPoints}</div>
                <div class="text-[9px] sm:text-[10px] font-display uppercase tracking-wider text-slate-400">Squad Points</div>
              </div>
              <div class="text-[10px] sm:text-xs font-mono text-victoryEmerald font-bold truncate max-w-full">${formatCurrency(purse2)}</div>
            </div>
          </div>
          ` : ''}

          <!-- RANK 3 CARD (BRONZE) -->
          ${third ? `
          <div class="w-full md:flex-1 md:max-w-[260px] md:order-3 flex flex-col items-center">
            <div class="w-14 h-14 sm:w-20 sm:h-20 rounded-2xl p-2 bg-[#0a1024] border-2 border-amber-700 shadow-xl mb-1.5 flex items-center justify-center relative">
              <span class="absolute -top-2.5 -right-2 w-6 h-6 sm:w-7 sm:h-7 rounded-full bg-amber-700 text-white font-black font-display text-xs flex items-center justify-center shadow-lg border border-white">3</span>
              <img src="${logo3}" alt="${tag3}" class="w-full h-full object-contain filter drop-shadow" />
            </div>
            <div class="font-display font-black text-xs sm:text-base text-white uppercase tracking-wider text-center truncate max-w-full">${name3}</div>
            <div class="text-[10px] sm:text-xs text-slate-400 font-sans truncate max-w-full mb-1.5">${third.managerName || 'Manager'} (${tag3})</div>

            <div class="w-full rounded-2xl sm:rounded-3xl pedestal-bronze p-3 sm:p-4 flex flex-col justify-between items-center text-center cursor-pointer hover:scale-[1.02] transition shadow-xl" onclick="inspectTeamById('${tag3}')">
              <div class="text-[9px] sm:text-[10px] font-display font-bold tracking-widest text-amber-500 uppercase">3RD PLACE</div>
              <div class="my-2">
                <div class="text-xl sm:text-3xl font-black font-display text-white tracking-tight">${third.totalPoints}</div>
                <div class="text-[9px] sm:text-[10px] font-display uppercase tracking-wider text-slate-400">Squad Points</div>
              </div>
              <div class="text-[10px] sm:text-xs font-mono text-victoryEmerald font-bold truncate max-w-full">${formatCurrency(purse3)}</div>
            </div>
          </div>
          ` : ''}
        </div>

      </div>
    `;
  }

  // Render Complete Franchise Leaderboard Table (All Participating Teams)
  if (podiumRestTableBody) {
    podiumRestTableBody.innerHTML = '';
    if (standings.length === 0) {
      podiumRestTableBody.innerHTML = '<tr><td colspan="6" class="py-4 text-center text-xs text-slate-500 font-sans">No additional franchises in this room.</td></tr>';
    } else {
      standings.forEach((team) => {
        const teamTag = getTeamTag(team);
        const teamName = getTeamName(team);
        const teamLogo = getTeamLogo(team);
        const teamPurse = getTeamPurse(team);

        const tr = document.createElement('tr');
        const rankBadge = team.rank === 1 ? 'text-amber-400 font-black' : team.rank === 2 ? 'text-slate-300 font-black' : team.rank === 3 ? 'text-amber-600 font-black' : 'text-slate-400';
        tr.className = `hover:bg-white/5 transition cursor-pointer border-b border-white/5 ${team.rank <= 3 ? 'bg-white/[0.02]' : ''}`;
        tr.onclick = () => inspectTeamById(teamTag);
        tr.innerHTML = `
          <td class="py-3 px-3 font-mono font-bold text-left ${rankBadge}">
            ${team.rank === 1 ? '🥇 #1' : team.rank === 2 ? '🥈 #2' : team.rank === 3 ? '🥉 #3' : `#${team.rank}`}
          </td>
          <td class="py-3 px-3 text-left">
            <div class="flex items-center space-x-2">
              <img src="${teamLogo}" alt="${teamTag}" class="w-6 h-6 object-contain" />
              <span class="font-display font-black text-white uppercase">${teamName}</span>
              ${team.rank === 1 ? '<span class="px-1.5 py-0.2 rounded text-[9px] bg-amber-400 text-slate-950 font-black font-display uppercase tracking-widest">CHAMPION</span>' : ''}
            </div>
          </td>
          <td class="py-3 px-3 text-slate-300 font-sans text-left">${team.managerName || 'Manager'}</td>
          <td class="py-3 px-3 text-center font-mono text-slate-300">${team.squadCount || (team.squad ? team.squad.length : 0)} players</td>
          <td class="py-3 px-3 text-right font-mono text-amber-400 font-bold">${formatCurrency(teamPurse)}</td>
          <td class="py-3 px-3 text-right font-mono text-laserCyan font-black text-sm">★ ${team.totalPoints} pts</td>
        `;
        podiumRestTableBody.appendChild(tr);
      });
    }
  }
}

// Global inspect squad helper for podium clicks
window.inspectTeamById = function(teamId) {
  if (!currentRoom || !currentRoom.teams) return;
  const team = currentRoom.teams.find(t => t.franchiseId === teamId);
  if (team) openSquadModal(team);
};


// SOCKET.IO REAL-TIME LISTENERS
function registerSocketAuctionListeners(s) {
  if (!s || s._auctionListenersAttached) return;
  s._auctionListenersAttached = true;

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
      renderPodium(roomState.standings);
    }
  });

  let lastBidTime = 0;
  let lastBidderTeam = null;

  s.on('timer_tick', ({ seconds, isRunning }) => {
    if (isRunning) {
      auctionTimer.textContent = seconds;
      if (seconds <= 3) {
        auctionTimer.classList.add('timer-panic');
        if (panicScreenVignette) panicScreenVignette.classList.remove('hidden');
        playBeep(880, 'square', 0.08);
        if (seconds === 3) speakCommentary('Going once!');
        else if (seconds === 2) speakCommentary('Going twice!');
        else if (seconds === 1) speakCommentary('Final call!');
      } else if (seconds <= 7) {
        auctionTimer.classList.remove('timer-panic', 'text-slate-300');
        auctionTimer.classList.add('text-amber-400');
        if (panicScreenVignette) panicScreenVignette.classList.add('hidden');
      } else {
        auctionTimer.classList.remove('timer-panic', 'text-amber-400');
        auctionTimer.classList.add('text-slate-300');
        if (panicScreenVignette) panicScreenVignette.classList.add('hidden');
      }
    } else {
      auctionTimer.textContent = '--';
      auctionTimer.classList.remove('timer-panic', 'text-amber-400');
      auctionTimer.classList.add('text-slate-400');
      if (panicScreenVignette) panicScreenVignette.classList.add('hidden');
      if (biddingWarBanner) biddingWarBanner.classList.add('hidden');
    }
  });

  s.on('bid_accepted', ({ currentBid, highestBidder, foldedTeams }) => {
    const prevBid = currentRoom ? currentRoom.currentBid : 0;
    const bidDiff = prevBid > 0 ? (currentBid - prevBid) : currentBid;

    if (currentRoom) {
      currentRoom.currentBid = currentBid;
      currentRoom.highestBidder = highestBidder;
      currentRoom.isTimerRunning = true;
      currentRoom.foldedTeams = Array.isArray(foldedTeams) ? foldedTeams : [];
    }
    if (myTeam) {
      myTeam.isFolded = false;
    }

    if (highestBidder) {
      activeLotBidHistory.unshift({
        teamId: highestBidder.teamId,
        teamName: highestBidder.teamName || highestBidder.teamId,
        amount: currentBid,
        time: new Date()
      });
      if (activeLotBidHistory.length > 8) activeLotBidHistory.pop();
      renderRecentBidsFeed();
    }

    currentBidAmount.textContent = formatCurrency(currentBid);
    currentBidAmount.classList.remove('animate-bid-punch');
    void currentBidAmount.offsetWidth; // re-flow
    currentBidAmount.classList.add('animate-bid-punch');

    const spotlightBar = document.getElementById('auctionSpotlightBar');
    if (spotlightBar) {
      spotlightBar.classList.remove('bid-flash-active');
      void spotlightBar.offsetWidth;
      spotlightBar.classList.add('bid-flash-active');
    }

    // Spawn floating currency chip (+₹25 L or +₹1.00 Cr)
    if (bidDiff > 0 && prevBid > 0) {
      spawnFloatingCurrency(`+${formatCurrency(bidDiff)}`);
    }

    // Dynamic Bidding War Detector (two different teams bidding within 4 seconds)
    const now = Date.now();
    if (lastBidTime > 0 && (now - lastBidTime < 4000) && lastBidderTeam && lastBidderTeam !== highestBidder.teamId) {
      if (biddingWarBanner) biddingWarBanner.classList.remove('hidden');
    }
    lastBidTime = now;
    lastBidderTeam = highestBidder.teamId;

    // Trigger franchise dynamic aura
    if (highestBidder && highestBidder.teamId) {
      setFranchiseAura(highestBidder.teamId);
    }

    if (highestBidder) {
      if (highestBidderName) highestBidderName.textContent = `${highestBidder.teamName} (${highestBidder.teamId}) - ${highestBidder.managerName}`;
      if (highestBidderPlaceholderIcon) highestBidderPlaceholderIcon.classList.add('hidden');
      if (highestBidderLogoImg) {
        highestBidderLogoImg.classList.remove('hidden');
        highestBidderLogoImg.src = highestBidder.logo || `/logos/${highestBidder.teamId}.svg`;
      }
      if (highestBidderBadge) {
        highestBidderBadge.style.backgroundColor = highestBidder.color || '#334155';
        highestBidderBadge.classList.add('scale-105', 'border-amber-400');
        setTimeout(() => highestBidderBadge.classList.remove('scale-105', 'border-amber-400'), 500);
      }
    }

    playBidSound();
    updateBidButton();

    // Update Live Match Activity Wire with latest bid
    const bidderTag = highestBidder ? highestBidder.teamId : 'TEAM';
    updateMatchActivityWire(`💰 ${bidderTag} raised bid to ${formatCurrency(currentBid)}`, 'bid');

    // Commentary voice on major or new bids
    const priceText = (currentBid / 10000000).toFixed(2);
    speakCommentary(`${highestBidder.teamId} raises the bid to ${priceText} Crores!`);
  });

  s.on('player_sold', ({ player, team, price }) => {
    playHammerSound();
    triggerScreenMicroShake();
    if (panicScreenVignette) panicScreenVignette.classList.add('hidden');
    if (biddingWarBanner) biddingWarBanner.classList.add('hidden');

    // Clear folds immediately for upcoming lot transition
    if (currentRoom) currentRoom.foldedTeams = [];
    if (myTeam) myTeam.isFolded = false;
    btnFoldPlayer.disabled = true;
    foldButtonText.textContent = 'LOT ENDED';
    updateBidButton();

    playerSoldWatermark.classList.remove('hidden');
    playerSoldWatermark.classList.add('stamp-sold-anim');

    const priceText = (price / 10000000).toFixed(2);
    speakCommentary(`Sold! ${player.name} is sold to ${team.name} for ${priceText} Crores!`);

    if (myTeam && myTeam.franchiseId === team.franchiseId && typeof confetti === 'function') {
      confetti({ particleCount: 160, spread: 100, origin: { y: 0.6 } });
    }

    // Direct to Live Match Activity Wire without screen-covering toast
    const buyerName = team ? (team.name || team.franchiseId) : 'Franchise';
    updateMatchActivityWire(`🔨 SOLD! ${player.name} to ${buyerName} for ${formatCurrency(price)}`, 'sold');
  });

  s.on('player_unsold', ({ player }) => {
    playHammerSound();
    triggerScreenMicroShake();
    if (panicScreenVignette) panicScreenVignette.classList.add('hidden');
    if (biddingWarBanner) biddingWarBanner.classList.add('hidden');

    // Clear folds immediately for upcoming lot transition
    if (currentRoom) currentRoom.foldedTeams = [];
    if (myTeam) myTeam.isFolded = false;
    btnFoldPlayer.disabled = true;
    foldButtonText.textContent = 'LOT ENDED';
    updateBidButton();

    playerUnsoldWatermark.classList.remove('hidden');
    playerUnsoldWatermark.classList.add('stamp-sold-anim');
    speakCommentary(`No bids received. ${player.name} goes unsold.`);

    // Direct to Live Match Activity Wire without screen-covering toast
    updateMatchActivityWire(`❌ ${player.name} went UNSOLD at base price ₹${(player.basePrice / 10000000).toFixed(2)} Cr`, 'unsold');
  });

  s.on('all_teams_folded', ({ player, highestBidder }) => {
    playHammerSound();
    triggerScreenMicroShake();
    if (panicScreenVignette) panicScreenVignette.classList.add('hidden');
    if (biddingWarBanner) biddingWarBanner.classList.add('hidden');

    // Clear folds immediately for upcoming lot transition
    if (currentRoom) currentRoom.foldedTeams = [];
    if (myTeam) myTeam.isFolded = false;
    btnFoldPlayer.disabled = true;
    foldButtonText.textContent = 'LOT ENDED';
    updateBidButton();

    if (highestBidder) {
      speakCommentary(`All remaining teams have folded! ${player.name} is sold early to ${highestBidder.teamName}!`);
      updateMatchActivityWire(`⚡ All teams folded! Hammer falls early: ${player.name} to ${highestBidder.teamName}`, 'sold');
    } else {
      speakCommentary(`All teams have folded without any bids. ${player.name} goes unsold.`);
      updateMatchActivityWire(`⚡ All teams folded! ${player.name} passed unsold`, 'unsold');
    }
  });

  s.on('auction_concluding', ({ reason, countdown }) => {
    if (auctionConcludingBanner) {
      if (auctionConcludingText) {
        auctionConcludingText.textContent = `AUCTION CONCLUDING in ${countdown || 5}s (${reason || 'Finalizing squads'})...`;
      }
      auctionConcludingBanner.classList.remove('hidden');
    }
    updateMatchActivityWire(`🏁 Auction concluding in ${countdown || 5}s (${reason || 'wrapping up'})...`, 'announcement');
    playBeep(440, 'triangle', 0.4);
  });

  s.on('auction_concluded', ({ standings, roomState }) => {
    if (auctionConcludingBanner) auctionConcludingBanner.classList.add('hidden');
    if (roomState) currentRoom = roomState;
    updateMatchActivityWire('🏆 Auction concluded! Championship standings locked.', 'sold');
    renderPodium(standings);
  });

  s.on('new_log', (entry) => {
    renderLogEntry(entry);
  });

  // Sudden Death Timer Shortened (Zero-bid consensus fold: 1 team remaining)
  s.on('timer_shortened', ({ seconds, message }) => {
    playBeep(987.77, 'sawtooth', 0.25);
    setTimeout(() => playBeep(1318.51, 'square', 0.3), 150);
    showToast(`⚠️ SUDDEN DEATH! ${message || '5s countdown to bid!'}`, 'warning');
    speakCommentary('Sudden Death! Only five seconds remaining on the clock!');
    if (auctionTimer) {
      auctionTimer.textContent = seconds || 5;
      auctionTimer.classList.add('timer-panic');
    }
  });

  // Targeted Visual Cheer Animation (Sent to franchise manager and sender)
  s.on('spectator_cheer_effect', ({ teamId, cheerType, cheerEmoji }) => {
    if (!window.userSettings || !window.userSettings.showCheers) return;
    spawnFloatingCheerSprite(cheerEmoji || '👏');
    if (cheerType === 'lightning') triggerLightningArc();
  });

  // Global Decibel Meter Broadcast (Real-time telemetry for all fans and managers)
  s.on('update_decibel_meter', ({ teamId, currentDecibel }) => {
    const decEl = document.getElementById('decibelFill');
    const decVal = document.getElementById('decibelValueText');
    const tagEl = document.getElementById('cheerTeamTag');
    if (decEl) decEl.style.width = `${Math.min(100, Math.max(10, currentDecibel))}%`;
    if (decVal) decVal.textContent = `${currentDecibel} dB`;
    if (tagEl && teamId) tagEl.textContent = teamId;
  });

  // Backward-compatible cheer broadcast listener
  s.on('broadcast_cheer', ({ teamId, cheerType, cheerEmoji, currentDecibel }) => {
    if (window.userSettings && window.userSettings.showCheers) {
      spawnFloatingCheerSprite(cheerEmoji);
      if (cheerType === 'lightning') triggerLightningArc();
    }
    const decEl = document.getElementById('decibelFill');
    const decVal = document.getElementById('decibelValueText');
    const tagEl = document.getElementById('cheerTeamTag');
    if (decEl) decEl.style.width = `${Math.min(100, Math.max(10, currentDecibel))}%`;
    if (decVal) decVal.textContent = `${currentDecibel} dB`;
    if (tagEl && teamId) tagEl.textContent = teamId;
  });

  // Decibel decay listener
  s.on('decibel_decay', ({ decibelMeter }) => {
    const decEl = document.getElementById('decibelFill');
    const decVal = document.getElementById('decibelValueText');
    const currentTeam = currentAllegiance || (currentRoom && currentRoom.highestBidder ? currentRoom.highestBidder.teamId : 'CSK');
    const val = (decibelMeter && decibelMeter[currentTeam]) || 50;
    if (decEl) decEl.style.width = `${Math.min(100, Math.max(10, val))}%`;
    if (decVal) decVal.textContent = `${val} dB`;
  });

  // Host Moderation: Kicked from Room
  s.on('kicked_from_room', ({ roomCode, reason }) => {
    playBeep(220, 'sawtooth', 0.4);
    showToast(reason || 'You have been kicked from the match by the host.', 'error');
    if (roomCode) removeActiveSession(roomCode);
    currentRoom = null;
    myTeam = null;
    navigate('home', null, true);
  });

  // Session Invalidated / Expired
  s.on('session_invalid', ({ message }) => {
    showToast(message || 'Your previous session in this room is no longer valid.', 'warning');
    if (currentRoom && currentRoom.code) {
      removeActiveSession(currentRoom.code);
    }
  });

  // Unique Name Conflict Error
  s.on('join_error', ({ message }) => {
    showToast(message || 'Name already taken in this room.', 'error');
  });
}

// Ensure listeners are bound if socket is already present
if (socket) {
  registerSocketAuctionListeners(socket);
}

// Initial Boot View Dispatch
(function bootInitialView() {
  const path = window.location.pathname.toLowerCase();
  const params = new URLSearchParams(window.location.search);
  const qRoom = params.get('room');
  const roomCode = qRoom ? qRoom.toUpperCase() : null;

  let initialView = 'home';
  if (path.includes('lobby') || window.location.hash.includes('lobby')) initialView = 'lobby';
  else if (path.includes('auction') || window.location.hash.includes('auction')) initialView = 'auction';
  else if (path.includes('podium') || window.location.hash.includes('podium')) initialView = 'podium';

  showView(initialView, roomCode);
  if (initialView === 'lobby') {
    renderFranchiseGrid();
  }
})();
