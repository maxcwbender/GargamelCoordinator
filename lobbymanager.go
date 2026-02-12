package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/paralin/go-dota2"
	"github.com/paralin/go-dota2/cso"
	devents "github.com/paralin/go-dota2/events"
	"github.com/paralin/go-dota2/protocol"
	"github.com/paralin/go-dota2/socache"
	"github.com/paralin/go-steam"
	"github.com/paralin/go-steam/protocol/gamecoordinator"
	"github.com/paralin/go-steam/protocol/steamlang"
	"github.com/paralin/go-steam/steamid"
	"github.com/sirupsen/logrus"
	"google.golang.org/protobuf/proto"
)

// GameMode enum values (from DotaTalker.py)
const (
	DOTA_GAMEMODE_NONE          = 0
	DOTA_GAMEMODE_CM            = 2
	DOTA_GAMEMODE_RD            = 3
	DOTA_GAMEMODE_SD            = 4
	DOTA_GAMEMODE_AR            = 5
	DOTA_GAMEMODE_REVERSE_CM    = 8
	DOTA_GAMEMODE_MO            = 11
	DOTA_GAMEMODE_LP            = 12
	DOTA_GAMEMODE_CD            = 16
	DOTA_GAMEMODE_ABILITY_DRAFT = 18
	DOTA_GAMEMODE_ARDM          = 20
	DOTA_GAMEMODE_ALL_DRAFT     = 22 // Ranked All Pick
	DOTA_GAMEMODE_TURBO         = 23
)

// LobbyMember represents a player in the lobby
type LobbyMember struct {
	SteamID uint64
	Name    string
	Team    int32 // 0 = Radiant, 1 = Dire, 2+ = Spectator/Unassigned
}

// GameConfig holds configuration for a single game
type GameConfig struct {
	GameID          string   `json:"game_id"`
	Username        string   `json:"username"`
	Password        string   `json:"password"`
	RadiantTeam     []uint64 `json:"radiant_team"`
	DireTeam        []uint64 `json:"dire_team"`
	ResultURL       string   `json:"result_url"`                  // URL to POST results to when game ends
	ServerRegion    uint32   `json:"server_region"`               // Default: 2 (US East)
	GameMode        uint32   `json:"game_mode"`                   // Default: 22 (Ranked All Pick)
	AllowCheats     bool     `json:"allow_cheats"`                // Default: false
	GameName        string   `json:"game_name"`                   // Default: auto-generated
	PassKey         string   `json:"pass_key"`                    // Optional lobby password
	DebugSteamID    uint64   `json:"debug_steam_id"`              // Optional: for debug mode
	DebugMode       bool     `json:"debug_mode"`                  // Debug mode from config.json - reduces player threshold
	PollCallbackURL string   `json:"poll_callback_url,omitempty"` // Optional: URL to notify when polling should be triggered
	LobbyReadyURL   string   `json:"lobby_ready_url,omitempty"`   // Optional: URL to notify when lobby is established
	GameStartedURL  string   `json:"game_started_url,omitempty"`  // Optional: URL to notify when game starts (match_id available)
	LeagueID        uint32   `json:"league_id"`                   // League ID from config.json
}

// GameStatus represents the current status of a game
type GameStatus struct {
	GameID        string   `json:"game_id"`
	State         string   `json:"state"` // "creating", "waiting", "launching", "in_progress", "postgame", "completed", "error"
	LobbyID       uint64   `json:"lobby_id"`
	GameMode      uint32   `json:"game_mode"`
	ServerRegion  uint32   `json:"server_region"`
	AllowCheats   bool     `json:"allow_cheats"`
	RadiantCount  int      `json:"radiant_count"`
	DireCount     int      `json:"dire_count"`
	RadiantTeam   []uint64 `json:"radiant_team"`
	DireTeam      []uint64 `json:"dire_team"`
	PollingActive bool     `json:"polling_active"`
	PollingDone   bool     `json:"polling_done"`
	PassKey       string   `json:"pass_key,omitempty"`
	Error         string   `json:"error,omitempty"`
}

// GameResult holds the final game result information
type GameResult struct {
	GameID       string    `json:"game_id"`
	MatchID      uint64    `json:"match_id"`
	LobbyID      uint64    `json:"lobby_id"`
	Outcome      int32     `json:"outcome"`  // 2 = Radiant win, 3 = Dire win
	Duration     uint32    `json:"duration"` // Duration in seconds
	RadiantScore uint32    `json:"radiant_score"`
	DireScore    uint32    `json:"dire_score"`
	GameName     string    `json:"game_name"`
	StartTime    uint32    `json:"start_time"`
	LobbyType    uint32    `json:"lobby_type"`
	GameMode     uint32    `json:"game_mode"`
	ServerRegion uint32    `json:"server_region"`
	Timestamp    time.Time `json:"timestamp"`
}

// CreateGameRequest represents a request to create a new game
type CreateGameRequest struct {
	GameID          string   `json:"game_id"`
	Username        string   `json:"username"`
	Password        string   `json:"password"`
	RadiantTeam     []uint64 `json:"radiant_team"`
	DireTeam        []uint64 `json:"dire_team"`
	ResultURL       string   `json:"result_url"`
	ServerRegion    *uint32  `json:"server_region,omitempty"`     // Optional, default: 2
	GameMode        *uint32  `json:"game_mode,omitempty"`         // Optional, default: 22
	AllowCheats     *bool    `json:"allow_cheats,omitempty"`      // Optional, default: false
	GameName        string   `json:"game_name,omitempty"`         // Optional
	PassKey         string   `json:"pass_key,omitempty"`          // Optional
	DebugSteamID    uint64   `json:"debug_steam_id,omitempty"`    // Optional
	PollCallbackURL string   `json:"poll_callback_url,omitempty"` // Optional: URL to notify when polling should be triggered
	LobbyReadyURL   string   `json:"lobby_ready_url,omitempty"`   // Optional: URL to notify when lobby is established
	GameStartedURL  string   `json:"game_started_url,omitempty"`  // Optional: URL to notify when game starts (match_id available)
}

// UpdateLobbySettingsRequest represents a request to update lobby settings
type UpdateLobbySettingsRequest struct {
	GameMode     *uint32  `json:"game_mode,omitempty"`
	ServerRegion *uint32  `json:"server_region,omitempty"`
	AllowCheats  *bool    `json:"allow_cheats,omitempty"`
	GameName     string   `json:"game_name,omitempty"`
	RadiantTeam  []uint64 `json:"radiant_team,omitempty"`
	DireTeam     []uint64 `json:"dire_team,omitempty"`
}

// AccountInfo holds credentials for a single Steam account
type AccountInfo struct {
	Username string
	Password string
}

// AccountPool manages allocation and release of Steam accounts
type AccountPool struct {
	accounts []AccountInfo
	inUse    map[int]string // account index -> game ID
	mutex    sync.RWMutex
}

// NewAccountPool creates a new account pool by loading accounts from config.json
func NewAccountPool() (*AccountPool, error) {
	pool := &AccountPool{
		accounts: make([]AccountInfo, 0),
		inUse:    make(map[int]string),
	}

	// Read config.json
	configData, err := os.ReadFile("config.json")
	if err != nil {
		return nil, fmt.Errorf("failed to read config.json: %v", err)
	}

	var configJSON map[string]interface{}
	if err := json.Unmarshal(configData, &configJSON); err != nil {
		return nil, fmt.Errorf("failed to parse config.json: %v", err)
	}

	// Load accounts (username_0/password_0, username_1/password_1, etc.)
	// Support up to 10 accounts for scalability
	for i := 0; i < 10; i++ {
		usernameKey := fmt.Sprintf("username_%d", i)
		passwordKey := fmt.Sprintf("password_%d", i)

		usernameVal, usernameOk := configJSON[usernameKey]
		passwordVal, passwordOk := configJSON[passwordKey]

		if usernameOk && passwordOk {
			username, ok1 := usernameVal.(string)
			password, ok2 := passwordVal.(string)
			if ok1 && ok2 && username != "" && password != "" {
				pool.accounts = append(pool.accounts, AccountInfo{
					Username: username,
					Password: password,
				})
				log.Printf("Loaded account %d: %s", i, username)
			}
		}
	}

	if len(pool.accounts) == 0 {
		return nil, fmt.Errorf("no accounts found in config.json")
	}

	log.Printf("Account pool initialized with %d account(s)", len(pool.accounts))
	return pool, nil
}

// Allocate assigns an available account to a game
// Returns account index and credentials, or error if all accounts are busy
func (p *AccountPool) Allocate(gameID string) (int, AccountInfo, error) {
	p.mutex.Lock()
	defer p.mutex.Unlock()

	for i := range p.accounts {
		if _, inUse := p.inUse[i]; !inUse {
			p.inUse[i] = gameID
			log.Printf("[AccountPool] Allocated account %d to game %s", i, gameID)
			return i, p.accounts[i], nil
		}
	}

	return -1, AccountInfo{}, fmt.Errorf("all accounts are currently in use")
}

// Release frees an account when a game ends
func (p *AccountPool) Release(accountIndex int, gameID string) {
	p.mutex.Lock()
	defer p.mutex.Unlock()

	if assignedGameID, exists := p.inUse[accountIndex]; exists {
		if assignedGameID == gameID {
			delete(p.inUse, accountIndex)
			log.Printf("[AccountPool] Released account %d from game %s", accountIndex, gameID)
		} else {
			log.Printf("[AccountPool] Warning: account %d was assigned to game %s, not %s", accountIndex, assignedGameID, gameID)
		}
	} else {
		log.Printf("[AccountPool] Warning: account %d was not in use", accountIndex)
	}
}

// GetAccountInfo returns account info for a given index (for debugging)
func (p *AccountPool) GetAccountInfo(accountIndex int) (AccountInfo, bool) {
	p.mutex.RLock()
	defer p.mutex.RUnlock()

	if accountIndex >= 0 && accountIndex < len(p.accounts) {
		return p.accounts[accountIndex], true
	}
	return AccountInfo{}, false
}

// GetAvailableCount returns the number of available accounts
func (p *AccountPool) GetAvailableCount() int {
	p.mutex.RLock()
	defer p.mutex.RUnlock()

	return len(p.accounts) - len(p.inUse)
}

// GetTotalCount returns the total number of accounts
func (p *AccountPool) GetTotalCount() int {
	p.mutex.RLock()
	defer p.mutex.RUnlock()

	return len(p.accounts)
}

type gcHandler struct {
	gameID               string
	gameConfig           *GameConfig
	dota                 *dota2.Dota2
	client               *steam.Client
	currentLobbyID       uint64
	currentGameName      string
	gameInProgress       bool
	pendingResults       map[uint64]*GameResult
	resultsMutex         sync.Mutex
	botMovedToUnassigned bool
	gameLaunched         bool
	lobbyMembers         map[uint64]*LobbyMember
	membersMutex         sync.Mutex
	lastKnownState       uint32
	lastKnownRegion      uint32
	lastKnownMemberCount int
	lastKnownAllowCheats *bool
	lastTeamCheckTime    time.Time
	teamCheckMutex       sync.Mutex
	lobbyShouldExist     bool
	reconnectMutex       sync.Mutex
	reconnecting         bool
	state                string // "creating", "waiting", "launching", "in_progress", "postgame", "completed", "error"
	stateMutex           sync.Mutex
	errorMessage         string
	ctx                  context.Context
	cancel               context.CancelFunc
	keepaliveRunning     bool
	keepaliveMutex       sync.Mutex
	pollingActive        bool
	pollingDone          bool
	pollCallbackSent     bool   // True once we've notified Master_Bot to start the poll (prevents duplicate callbacks)
	pollingMutex         sync.Mutex
	pollingMessageSent   bool   // Track if we've sent the "polling active" message to avoid duplicates
	pollCallbackURL      string // URL to notify when polling should be triggered
	lobbyReadyURL        string // URL to notify when lobby is established
	lobbyReadyNotified   bool   // Track if lobby ready callback has been sent
	lobbyReadyMutex      sync.Mutex
	gameStartedURL       string // URL to notify when game starts (match_id available)
	gameStartedNotified  bool   // Track if game started callback has been sent
	gameStartedMutex     sync.Mutex
	invitesSent          bool // Track if invites have been sent
	invitesMutex         sync.Mutex
	playersInvited       map[uint64]bool // Track which players have been invited (per lobby)
	playersInvitedMutex  sync.Mutex
	resultSent           bool // Track if result has been sent to prevent duplicates
	resultSentMutex      sync.Mutex
	accountIndex         int // Index of the account assigned to this game (-1 if not allocated)
}

// GameManager manages multiple concurrent games
type GameManager struct {
	games map[string]*gcHandler
	mutex sync.RWMutex
}

func NewGameManager() *GameManager {
	return &GameManager{
		games: make(map[string]*gcHandler),
	}
}

func (gm *GameManager) AddGame(gameID string, handler *gcHandler) {
	gm.mutex.Lock()
	defer gm.mutex.Unlock()
	gm.games[gameID] = handler
}

func (gm *GameManager) GetGame(gameID string) (*gcHandler, bool) {
	gm.mutex.RLock()
	defer gm.mutex.RUnlock()
	handler, exists := gm.games[gameID]
	return handler, exists
}

func (gm *GameManager) RemoveGame(gameID string) {
	gm.mutex.Lock()
	defer gm.mutex.Unlock()
	delete(gm.games, gameID)
}

func (gm *GameManager) GetAllGames() map[string]*gcHandler {
	gm.mutex.RLock()
	defer gm.mutex.RUnlock()
	result := make(map[string]*gcHandler)
	for k, v := range gm.games {
		result[k] = v
	}
	return result
}

// Dota2 GC message types
const (
	EDOTAGCMsg_k_EMsgGCPracticeLobbyUpdate = 7038
	EDOTAGCMsg_k_EMsgGCMatchDetails        = 7034
	EDOTAGCMsg_k_EMsgGCUpdateMatchDetails  = 7035
)

// Steam GC message types
const (
	k_ESOMsg_UpdateMultiple = 26
)

// Team constants
const (
	DOTA_GC_TEAM_GOOD_GUYS   = 0 // Radiant
	DOTA_GC_TEAM_BAD_GUYS    = 1 // Dire
	DOTA_GC_TEAM_SPECTATOR   = 2 // Spectator/Unassigned
	DOTA_GC_TEAM_PLAYER_POOL = 3 // Player pool (unassigned)
)

var gameManager = NewGameManager()
var accountPool *AccountPool

func (h *gcHandler) HandleGCPacket(p *gamecoordinator.GCPacket) {
	h.dota.HandleGCPacket(p)

	switch p.MsgType {
	case EDOTAGCMsg_k_EMsgGCPracticeLobbyUpdate:
		h.handleLobbyUpdate(p.Body)
	case EDOTAGCMsg_k_EMsgGCMatchDetails, EDOTAGCMsg_k_EMsgGCUpdateMatchDetails:
		h.handleMatchDetails(p.Body)
	case k_ESOMsg_UpdateMultiple:
		h.handleUpdateMultiple(p.Body)
	default:
		if h.gameInProgress || len(h.pendingResults) > 0 {
			if len(p.Body) > 10 {
				h.tryParseAsMatchDetails(p.Body, p.MsgType)
			}
		}
	}
}

func (h *gcHandler) setState(state string) {
	h.stateMutex.Lock()
	defer h.stateMutex.Unlock()
	h.state = state
}

func (h *gcHandler) getState() string {
	h.stateMutex.Lock()
	defer h.stateMutex.Unlock()
	return h.state
}

func (h *gcHandler) setError(err string) {
	h.stateMutex.Lock()
	defer h.stateMutex.Unlock()
	h.errorMessage = err
	h.state = "error"
}

func (h *gcHandler) getError() string {
	h.stateMutex.Lock()
	defer h.stateMutex.Unlock()
	return h.errorMessage
}

// [Previous handler methods continue...]
// For brevity, I'll include the key handler methods but note that most of the existing
// parseCSODOTALobbyFromObjectData, handleUpdateMultiple, etc. remain the same
// but now reference h.gameConfig instead of h.config

// Continue with existing handler implementation...
// [Rest of the file continues with all the existing handler methods, but updated to use h.gameConfig]

func main() {
	// Redirect log output to stdout instead of stderr
	log.SetOutput(os.Stdout)

	log.Println("Starting Gargamel Lobby Manager REST API server...")

	// Initialize account pool
	var err error
	accountPool, err = NewAccountPool()
	if err != nil {
		log.Fatalf("Failed to initialize account pool: %v", err)
	}

	// Start HTTP server
	http.HandleFunc("/game", handleCreateGame)
	http.HandleFunc("/game/", handleGameOperations)
	http.HandleFunc("/games", handleListGames)
	http.HandleFunc("/poll/", handlePollOperations)

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	log.Printf("REST API server listening on port %s", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}

func handleCreateGame(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req CreateGameRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, fmt.Sprintf("Invalid request: %v", err), http.StatusBadRequest)
		return
	}

	// Validate required fields
	if req.GameID == "" {
		http.Error(w, "game_id is required", http.StatusBadRequest)
		return
	}
	if req.ResultURL == "" {
		http.Error(w, "result_url is required", http.StatusBadRequest)
		return
	}
	if len(req.RadiantTeam) == 0 && len(req.DireTeam) == 0 {
		http.Error(w, "at least one team must have players", http.StatusBadRequest)
		return
	}

	// Check if game already exists
	if _, exists := gameManager.GetGame(req.GameID); exists {
		http.Error(w, fmt.Sprintf("Game %s already exists", req.GameID), http.StatusConflict)
		return
	}

	// Allocate an account from the pool
	accountIndex, accountInfo, err := accountPool.Allocate(req.GameID)
	if err != nil {
		http.Error(w, fmt.Sprintf("No available accounts: %v", err), http.StatusServiceUnavailable)
		log.Printf("[Game %s] Failed to allocate account: %v", req.GameID, err)
		return
	}
	log.Printf("[Game %s] Allocated account %d (%s)", req.GameID, accountIndex, accountInfo.Username)

	// Create game config with defaults
	serverRegion := uint32(2) // US East
	if req.ServerRegion != nil {
		serverRegion = *req.ServerRegion
	}

	gameMode := uint32(22) // Ranked All Pick
	if req.GameMode != nil {
		gameMode = *req.GameMode
	}

	allowCheats := false
	if req.AllowCheats != nil {
		allowCheats = *req.AllowCheats
	}

	gameName := req.GameName
	if gameName == "" {
		gameName = fmt.Sprintf("gargamel_game_%s", req.GameID)
	}

	// Read league_id and DEBUG_MODE from config.json
	leagueID := uint32(0)
	debugMode := false
	if configData, err := os.ReadFile("config.json"); err == nil {
		var configJSON map[string]interface{}
		if err := json.Unmarshal(configData, &configJSON); err == nil {
			if leagueIDVal, ok := configJSON["league_id"]; ok {
				if leagueIDFloat, ok := leagueIDVal.(float64); ok {
					leagueID = uint32(leagueIDFloat)
					log.Printf("[Game %s] Loaded league_id from config.json: %d", req.GameID, leagueID)
				}
			}
			if debugModeVal, ok := configJSON["DEBUG_MODE"]; ok {
				if debugModeBool, ok := debugModeVal.(bool); ok {
					debugMode = debugModeBool
					log.Printf("[Game %s] Loaded DEBUG_MODE from config.json: %v", req.GameID, debugMode)
				}
			}
		}
	}

	config := &GameConfig{
		GameID:          req.GameID,
		Username:        accountInfo.Username, // Use allocated account
		Password:        accountInfo.Password, // Use allocated account
		RadiantTeam:     req.RadiantTeam,
		DireTeam:        req.DireTeam,
		ResultURL:       req.ResultURL,
		ServerRegion:    serverRegion,
		GameMode:        gameMode,
		AllowCheats:     allowCheats,
		GameName:        gameName,
		PassKey:         req.PassKey,
		DebugSteamID:    req.DebugSteamID,
		DebugMode:       debugMode,
		PollCallbackURL: req.PollCallbackURL,
		LobbyReadyURL:   req.LobbyReadyURL,
		GameStartedURL:  req.GameStartedURL,
		LeagueID:        leagueID,
	}

	// Create handler and start game
	ctx, cancel := context.WithCancel(context.Background())
	handler := &gcHandler{
		gameID:              req.GameID,
		gameConfig:          config,
		accountIndex:        accountIndex, // Store account index for later release
		pendingResults:      make(map[uint64]*GameResult),
		lobbyMembers:        make(map[uint64]*LobbyMember),
		ctx:                 ctx,
		cancel:              cancel,
		state:               "creating",
		pollingActive:       false,
		pollingDone:         false,
		pollCallbackURL:     req.PollCallbackURL,
		lobbyReadyURL:       req.LobbyReadyURL,
		lobbyReadyNotified:  false,
		gameStartedURL:      req.GameStartedURL,
		gameStartedNotified: false,
		playersInvited:      make(map[uint64]bool),
	}

	gameManager.AddGame(req.GameID, handler)

	// Start game creation in background
	go func() {
		defer func() {
			if r := recover(); r != nil {
				log.Printf("[Game %s] PANIC in createDotaLobby goroutine: %v", req.GameID, r)
				handler.setError(fmt.Sprintf("Panic: %v", r))
				// Release account on panic
				if accountPool != nil && handler.accountIndex >= 0 {
					accountPool.Release(handler.accountIndex, req.GameID)
					log.Printf("[Game %s] Released account %d due to panic", req.GameID, handler.accountIndex)
				}
			}
		}()

		log.Printf("[Game %s] Starting createDotaLobby goroutine", req.GameID)
		if err := createDotaLobby(ctx, handler, config); err != nil {
			handler.setError(err.Error())
			log.Printf("[Game %s] Error creating game: %v", req.GameID, err)
			// Release account if game creation fails
			if accountPool != nil && handler.accountIndex >= 0 {
				accountPool.Release(handler.accountIndex, req.GameID)
				log.Printf("[Game %s] Released account %d due to creation failure", req.GameID, handler.accountIndex)
			}
		} else {
			log.Printf("[Game %s] createDotaLobby returned successfully (event loop continues in background)", req.GameID)
		}
	}()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"game_id":  req.GameID,
		"status":   "creating",
		"password": config.PassKey,
	})
}

func handleGameOperations(w http.ResponseWriter, r *http.Request) {
	// Extract game ID and sub-operation from path
	path := r.URL.Path[len("/game/"):]
	if path == "" {
		http.Error(w, "game_id is required", http.StatusBadRequest)
		return
	}

	// Check for sub-operations: /game/{id}/swap, /game/{id}/replace, /game/{id}/chat
	parts := strings.Split(path, "/")
	gameID := parts[0]

	if len(parts) > 1 {
		// Handle sub-operations
		subOp := parts[1]
		handler, exists := gameManager.GetGame(gameID)
		if !exists {
			http.Error(w, fmt.Sprintf("Game %s not found", gameID), http.StatusNotFound)
			return
		}

		switch subOp {
		case "swap":
			handleSwapPlayers(w, r, handler, gameID)
			return
		case "replace":
			handleReplacePlayer(w, r, handler, gameID)
			return
		case "chat":
			handleSendChatMessage(w, r, handler, gameID)
			return
		}
	}

	// Regular game operations
	handler, exists := gameManager.GetGame(gameID)
	if !exists {
		http.Error(w, fmt.Sprintf("Game %s not found", gameID), http.StatusNotFound)
		return
	}

	switch r.Method {
	case http.MethodGet:
		handleGetGameStatus(w, r, handler)
	case http.MethodPut:
		handleUpdateLobbySettings(w, r, handler)
	case http.MethodDelete:
		handleDeleteGame(w, r, handler, gameID)
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func handleGetGameStatus(w http.ResponseWriter, r *http.Request, handler *gcHandler) {
	handler.membersMutex.Lock()
	radiantCount := 0
	direCount := 0
	for _, member := range handler.lobbyMembers {
		if member.Team == DOTA_GC_TEAM_GOOD_GUYS {
			radiantCount++
		} else if member.Team == DOTA_GC_TEAM_BAD_GUYS {
			direCount++
		}
	}
	handler.membersMutex.Unlock()

	handler.pollingMutex.Lock()
	pollingActive := handler.pollingActive
	pollingDone := handler.pollingDone
	handler.pollingMutex.Unlock()

	status := GameStatus{
		GameID:        handler.gameID,
		State:         handler.getState(),
		LobbyID:       handler.currentLobbyID,
		GameMode:      handler.gameConfig.GameMode,
		ServerRegion:  handler.gameConfig.ServerRegion,
		AllowCheats:   handler.gameConfig.AllowCheats,
		RadiantCount:  radiantCount,
		DireCount:     direCount,
		RadiantTeam:   handler.gameConfig.RadiantTeam,
		DireTeam:      handler.gameConfig.DireTeam,
		PollingActive: pollingActive,
		PollingDone:   pollingDone,
		PassKey:       handler.gameConfig.PassKey,
	}

	if err := handler.getError(); err != "" {
		status.Error = err
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(status)
}

func handleUpdateLobbySettings(w http.ResponseWriter, r *http.Request, handler *gcHandler) {
	var req UpdateLobbySettingsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, fmt.Sprintf("Invalid request: %v", err), http.StatusBadRequest)
		return
	}

	// Update config
	if req.GameMode != nil {
		handler.gameConfig.GameMode = *req.GameMode
	}
	if req.ServerRegion != nil {
		handler.gameConfig.ServerRegion = *req.ServerRegion
	}
	if req.AllowCheats != nil {
		handler.gameConfig.AllowCheats = *req.AllowCheats
	}
	if req.GameName != "" {
		handler.gameConfig.GameName = req.GameName
		handler.currentGameName = req.GameName
	}

	// Update teams if provided
	if req.RadiantTeam != nil {
		log.Printf("[Game %s] Updating Radiant team: %v", handler.gameID, req.RadiantTeam)
		handler.gameConfig.RadiantTeam = req.RadiantTeam
	}
	if req.DireTeam != nil {
		log.Printf("[Game %s] Updating Dire team: %v", handler.gameID, req.DireTeam)
		handler.gameConfig.DireTeam = req.DireTeam
	}

	// Apply settings to lobby if it exists
	if handler.currentLobbyID != 0 && handler.dota != nil {
		handler.setAllLobbySettings()
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "updated"})
}

// PollControlRequest represents a request to control polling
type PollControlRequest struct {
	Action   string  `json:"action"`              // "start", "end"
	GameMode *uint32 `json:"game_mode,omitempty"` // Required when action is "end"
}

func handlePollOperations(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Extract game ID from path (format: /poll/{game_id})
	pathParts := strings.Split(r.URL.Path[len("/poll/"):], "/")
	if len(pathParts) == 0 || pathParts[0] == "" {
		http.Error(w, "game_id is required", http.StatusBadRequest)
		return
	}
	gameID := pathParts[0]

	handler, exists := gameManager.GetGame(gameID)
	if !exists {
		http.Error(w, fmt.Sprintf("Game %s not found", gameID), http.StatusNotFound)
		return
	}

	var req PollControlRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, fmt.Sprintf("Invalid request: %v", err), http.StatusBadRequest)
		return
	}

	switch req.Action {
	case "start":
		handler.pollingMutex.Lock()
		handler.pollingActive = true
		handler.pollingDone = false
		handler.pollingMutex.Unlock()
		log.Printf("[Game %s] Polling marked as active", gameID)

		// Send chat notification
		// Join lobby channel first, then send message (like DotaTalker.py does)
		go func() {
			time.Sleep(1 * time.Second) // Reduced wait - give lobby a moment to be ready
			if handler.dota != nil && handler.currentLobbyID != 0 {
				// Join the lobby chat channel first (required before sending messages)
				channelName := fmt.Sprintf("Lobby_%d", handler.currentLobbyID)
				channelType := protocol.DOTAChatChannelTypeT_DOTAChannelType_Lobby

				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()

				joinResp, err := handler.dota.JoinChatChannel(ctx, channelName, channelType, false)
				if err != nil {
					log.Printf("[Game %s] Failed to join lobby channel: %v", gameID, err)
					// Try sending anyway - might work without joining
					handler.dota.SendChannelMessage(handler.currentLobbyID, "Game Polling has Started! Check #match-listings on Discord to Vote!!")
					log.Printf("[Game %s] Sent polling start message to lobby (without channel join)", gameID)
					return
				}

				if joinResp != nil && joinResp.GetResult() == protocol.CMsgDOTAJoinChatChannelResponse_JOIN_SUCCESS {
					// Use the channel ID from the join response
					channelID := joinResp.GetChannelId()
					if channelID != 0 {
						handler.dota.SendChannelMessage(channelID, "Game Polling has Started! Check #match-listings on Discord to Vote!!")
						log.Printf("[Game %s] Sent polling start message to lobby channel (channelID=%d)", gameID, channelID)
					} else {
						// Fallback to using lobby ID
						handler.dota.SendChannelMessage(handler.currentLobbyID, "Game Polling has Started! Check #match-listings on Discord to Vote!!")
						log.Printf("[Game %s] Sent polling start message to lobby (using lobbyID as fallback)", gameID)
					}
				} else {
					log.Printf("[Game %s] Failed to join lobby channel: result=%v", gameID, joinResp.GetResult())
					// Try sending anyway
					handler.dota.SendChannelMessage(handler.currentLobbyID, "Game Polling has Started! Check #match-listings on Discord to Vote!!")
					log.Printf("[Game %s] Sent polling start message to lobby (join failed but sent anyway)", gameID)
				}
			} else {
				log.Printf("[Game %s] Could not send polling message - dota=%v, lobbyID=%d", gameID, handler.dota != nil, handler.currentLobbyID)
			}
		}()

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "polling_started"})

	case "end":
		if req.GameMode == nil {
			http.Error(w, "game_mode is required when ending poll", http.StatusBadRequest)
			return
		}

		handler.pollingMutex.Lock()
		handler.pollingActive = false
		handler.pollingDone = true
		handler.pollingMessageSent = false // Reset flag when polling ends
		handler.pollingMutex.Unlock()

		// Update game mode
		handler.gameConfig.GameMode = *req.GameMode
		if handler.dota != nil && handler.currentLobbyID != 0 {
			handler.setAllLobbySettings()
		}

		log.Printf("[Game %s] Polling ended, game mode set to %d", gameID, *req.GameMode)

		// Try to launch if all players are ready
		go handler.processTeamAssignments(nil)

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"status": "polling_ended"})

	default:
		http.Error(w, "Invalid action. Use 'start' or 'end'", http.StatusBadRequest)
	}
}

// SwapPlayersRequest represents a request to swap two players
type SwapPlayersRequest struct {
	SteamID1 uint64 `json:"steam_id_1"`
	SteamID2 uint64 `json:"steam_id_2"`
}

func handleSwapPlayers(w http.ResponseWriter, r *http.Request, handler *gcHandler, gameID string) {
	// Track if we've sent a response to avoid double-sending
	responseSent := false
	defer func() {
		if !responseSent {
			log.Printf("[Game %s] WARNING: No response sent in swap handler, sending error response", gameID)
			http.Error(w, "Internal server error", http.StatusInternalServerError)
		}
	}()

	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		responseSent = true
		return
	}

	var req SwapPlayersRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		log.Printf("[Game %s] Swap request decode error: %v", gameID, err)
		http.Error(w, fmt.Sprintf("Invalid request: %v", err), http.StatusBadRequest)
		responseSent = true
		return
	}

	log.Printf("[Game %s] Swap request received: SteamID1=%d, SteamID2=%d", gameID, req.SteamID1, req.SteamID2)

	// Validate handler and config
	log.Printf("[Game %s] Validating handler and config...", gameID)
	if handler == nil {
		log.Printf("[Game %s] ERROR: Handler is nil", gameID)
		http.Error(w, "Internal error: handler is nil", http.StatusInternalServerError)
		responseSent = true
		return
	}
	if handler.gameConfig == nil {
		log.Printf("[Game %s] ERROR: gameConfig is nil", gameID)
		http.Error(w, "Internal error: game config is nil", http.StatusInternalServerError)
		responseSent = true
		return
	}
	log.Printf("[Game %s] Handler and config validated", gameID)

	// Get player names for logging (getPlayerDisplayName handles its own locking)
	log.Printf("[Game %s] Getting player names...", gameID)
	player1Name := handler.getPlayerDisplayName(req.SteamID1)
	player2Name := handler.getPlayerDisplayName(req.SteamID2)
	log.Printf("[Game %s] Got player names: %s, %s", gameID, player1Name, player2Name)

	// Log current team configuration before swap
	log.Printf("[Game %s] Before swap - RadiantTeam: %v, DireTeam: %v", gameID, handler.gameConfig.RadiantTeam, handler.gameConfig.DireTeam)

	// Validate players are on opposite teams
	steamID1InRadiant := false
	steamID2InRadiant := false
	steamID1InDire := false
	steamID2InDire := false

	for _, sid := range handler.gameConfig.RadiantTeam {
		if sid == req.SteamID1 {
			steamID1InRadiant = true
		}
		if sid == req.SteamID2 {
			steamID2InRadiant = true
		}
	}

	for _, sid := range handler.gameConfig.DireTeam {
		if sid == req.SteamID1 {
			steamID1InDire = true
		}
		if sid == req.SteamID2 {
			steamID2InDire = true
		}
	}

	log.Printf("[Game %s] Team validation - Player1 (%s): Radiant=%v, Dire=%v | Player2 (%s): Radiant=%v, Dire=%v",
		gameID, player1Name, steamID1InRadiant, steamID1InDire, player2Name, steamID2InRadiant, steamID2InDire)

	// Must be on opposite teams
	if !((steamID1InRadiant && steamID2InDire) || (steamID1InDire && steamID2InRadiant)) {
		log.Printf("[Game %s] Swap failed: Players must be on opposite teams", gameID)
		http.Error(w, "Players must be on opposite teams", http.StatusBadRequest)
		responseSent = true
		return
	}

	// Swap in config
	if steamID1InRadiant && steamID2InDire {
		log.Printf("[Game %s] Swapping: %s (Radiant) <-> %s (Dire)", gameID, player1Name, player2Name)
		// Remove from current teams
		for i, sid := range handler.gameConfig.RadiantTeam {
			if sid == req.SteamID1 {
				handler.gameConfig.RadiantTeam = append(handler.gameConfig.RadiantTeam[:i], handler.gameConfig.RadiantTeam[i+1:]...)
				log.Printf("[Game %s] Removed %s from Radiant team", gameID, player1Name)
				break
			}
		}
		for i, sid := range handler.gameConfig.DireTeam {
			if sid == req.SteamID2 {
				handler.gameConfig.DireTeam = append(handler.gameConfig.DireTeam[:i], handler.gameConfig.DireTeam[i+1:]...)
				log.Printf("[Game %s] Removed %s from Dire team", gameID, player2Name)
				break
			}
		}
		// Add to opposite teams
		handler.gameConfig.RadiantTeam = append(handler.gameConfig.RadiantTeam, req.SteamID2)
		handler.gameConfig.DireTeam = append(handler.gameConfig.DireTeam, req.SteamID1)
		log.Printf("[Game %s] Added %s to Radiant team, %s to Dire team", gameID, player2Name, player1Name)
	} else {
		log.Printf("[Game %s] Swapping: %s (Dire) <-> %s (Radiant)", gameID, player1Name, player2Name)
		// Remove from current teams
		for i, sid := range handler.gameConfig.DireTeam {
			if sid == req.SteamID1 {
				handler.gameConfig.DireTeam = append(handler.gameConfig.DireTeam[:i], handler.gameConfig.DireTeam[i+1:]...)
				log.Printf("[Game %s] Removed %s from Dire team", gameID, player1Name)
				break
			}
		}
		for i, sid := range handler.gameConfig.RadiantTeam {
			if sid == req.SteamID2 {
				handler.gameConfig.RadiantTeam = append(handler.gameConfig.RadiantTeam[:i], handler.gameConfig.RadiantTeam[i+1:]...)
				log.Printf("[Game %s] Removed %s from Radiant team", gameID, player2Name)
				break
			}
		}
		// Add to opposite teams
		handler.gameConfig.DireTeam = append(handler.gameConfig.DireTeam, req.SteamID2)
		handler.gameConfig.RadiantTeam = append(handler.gameConfig.RadiantTeam, req.SteamID1)
		log.Printf("[Game %s] Added %s to Dire team, %s to Radiant team", gameID, player2Name, player1Name)
	}

	// Log team configuration after swap
	log.Printf("[Game %s] After swap - RadiantTeam: %v, DireTeam: %v", gameID, handler.gameConfig.RadiantTeam, handler.gameConfig.DireTeam)

	// Send response immediately before any potentially slow operations
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(map[string]string{"status": "swapped"}); err != nil {
		log.Printf("[Game %s] Error encoding swap response: %v", gameID, err)
		responseSent = true
		return
	}

	// Flush the response to ensure it's sent immediately
	if flusher, ok := w.(http.Flusher); ok {
		flusher.Flush()
		log.Printf("[Game %s] Response flushed to client", gameID)
	}
	responseSent = true

	// Kick both players from teams so they re-seat correctly (non-blocking)
	if handler.dota != nil {
		steamID1_32 := uint32(req.SteamID1 & 0xFFFFFFFF)
		steamID2_32 := uint32(req.SteamID2 & 0xFFFFFFFF)
		log.Printf("[Game %s] Kicking players from teams to trigger re-seating: %s (32-bit: %d), %s (32-bit: %d)",
			gameID, player1Name, steamID1_32, player2Name, steamID2_32)
		handler.dota.KickLobbyMemberFromTeam(steamID1_32)
		handler.dota.KickLobbyMemberFromTeam(steamID2_32)
		log.Printf("[Game %s] Kicked both players from teams - they will re-seat on their new teams", gameID)
	} else {
		log.Printf("[Game %s] Warning: Dota client is nil, cannot kick players from teams", gameID)
	}

	log.Printf("[Game %s] Swap completed successfully: %s <-> %s", gameID, player1Name, player2Name)
}

// ReplacePlayerRequest represents a request to replace a player
type ReplacePlayerRequest struct {
	OldSteamID uint64 `json:"old_steam_id"`
	NewSteamID uint64 `json:"new_steam_id"`
}

func handleReplacePlayer(w http.ResponseWriter, r *http.Request, handler *gcHandler, gameID string) {
	// Track if we've sent a response to avoid double-sending
	responseSent := false
	defer func() {
		if !responseSent {
			log.Printf("[Game %s] WARNING: No response sent in replace handler, sending error response", gameID)
			http.Error(w, "Internal server error", http.StatusInternalServerError)
		}
	}()

	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		responseSent = true
		return
	}

	var req ReplacePlayerRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		log.Printf("[Game %s] Replace request decode error: %v", gameID, err)
		http.Error(w, fmt.Sprintf("Invalid request: %v", err), http.StatusBadRequest)
		responseSent = true
		return
	}

	log.Printf("[Game %s] Replace request received: OldSteamID=%d, NewSteamID=%d", gameID, req.OldSteamID, req.NewSteamID)

	// Validate handler and config
	log.Printf("[Game %s] Validating handler and config...", gameID)
	if handler == nil {
		log.Printf("[Game %s] ERROR: Handler is nil", gameID)
		http.Error(w, "Internal error: handler is nil", http.StatusInternalServerError)
		responseSent = true
		return
	}
	if handler.gameConfig == nil {
		log.Printf("[Game %s] ERROR: gameConfig is nil", gameID)
		http.Error(w, "Internal error: game config is nil", http.StatusInternalServerError)
		responseSent = true
		return
	}
	log.Printf("[Game %s] Handler and config validated", gameID)

	// Log current team configuration before replace
	log.Printf("[Game %s] Before replace - RadiantTeam: %v, DireTeam: %v", gameID, handler.gameConfig.RadiantTeam, handler.gameConfig.DireTeam)

	// Check if new player is already in game
	log.Printf("[Game %s] Checking if new player %d is already in game...", gameID, req.NewSteamID)
	for _, sid := range handler.gameConfig.RadiantTeam {
		if sid == req.NewSteamID {
			log.Printf("[Game %s] Replace failed: New player %d is already in Radiant team", gameID, req.NewSteamID)
			http.Error(w, "New player is already in the game", http.StatusBadRequest)
			responseSent = true
			return
		}
	}
	for _, sid := range handler.gameConfig.DireTeam {
		if sid == req.NewSteamID {
			log.Printf("[Game %s] Replace failed: New player %d is already in Dire team", gameID, req.NewSteamID)
			http.Error(w, "New player is already in the game", http.StatusBadRequest)
			responseSent = true
			return
		}
	}
	log.Printf("[Game %s] New player %d is not already in game", gameID, req.NewSteamID)

	// Get player names for logging (getPlayerDisplayName handles its own locking)
	log.Printf("[Game %s] Getting player names...", gameID)
	oldPlayerName := handler.getPlayerDisplayName(req.OldSteamID)
	newPlayerName := handler.getPlayerDisplayName(req.NewSteamID)
	log.Printf("[Game %s] Got player names: old=%s, new=%s", gameID, oldPlayerName, newPlayerName)

	// Find and replace in Radiant
	log.Printf("[Game %s] Searching for old player %s in Radiant team...", gameID, oldPlayerName)
	replaced := false
	for i, sid := range handler.gameConfig.RadiantTeam {
		if sid == req.OldSteamID {
			handler.gameConfig.RadiantTeam[i] = req.NewSteamID
			replaced = true
			log.Printf("[Game %s] Replaced %s with %s in Radiant team", gameID, oldPlayerName, newPlayerName)
			break
		}
	}

	// Find and replace in Dire if not found in Radiant
	if !replaced {
		log.Printf("[Game %s] Old player not found in Radiant, searching Dire team...", gameID)
		for i, sid := range handler.gameConfig.DireTeam {
			if sid == req.OldSteamID {
				handler.gameConfig.DireTeam[i] = req.NewSteamID
				replaced = true
				log.Printf("[Game %s] Replaced %s with %s in Dire team", gameID, oldPlayerName, newPlayerName)
				break
			}
		}
	}

	if !replaced {
		log.Printf("[Game %s] Replace failed: Old player %s not found in game", gameID, oldPlayerName)
		http.Error(w, "Old player not found in game", http.StatusBadRequest)
		responseSent = true
		return
	}

	// Log team configuration after replace
	log.Printf("[Game %s] After replace - RadiantTeam: %v, DireTeam: %v", gameID, handler.gameConfig.RadiantTeam, handler.gameConfig.DireTeam)

	// Send response immediately before any potentially slow operations
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(map[string]string{"status": "replaced"}); err != nil {
		log.Printf("[Game %s] Error encoding replace response: %v", gameID, err)
		responseSent = true
		return
	}

	// Flush the response to ensure it's sent immediately
	if flusher, ok := w.(http.Flusher); ok {
		flusher.Flush()
		log.Printf("[Game %s] Response flushed to client", gameID)
	}
	responseSent = true

	// Kick old player from team (non-blocking)
	if handler.dota != nil {
		oldSteamID32 := uint32(req.OldSteamID & 0xFFFFFFFF)
		log.Printf("[Game %s] Kicking old player %s (32-bit: %d) from team to trigger re-seating", gameID, oldPlayerName, oldSteamID32)
		handler.dota.KickLobbyMemberFromTeam(oldSteamID32)
		log.Printf("[Game %s] Kicked old player from team - new player will need to join", gameID)
	} else {
		log.Printf("[Game %s] Warning: Dota client is nil, cannot kick old player from team", gameID)
	}

	log.Printf("[Game %s] Replace completed successfully: %s -> %s", gameID, oldPlayerName, newPlayerName)
}

// ChatMessageRequest represents a request to send a chat message
type ChatMessageRequest struct {
	Message string `json:"message"`
}

func handleSendChatMessage(w http.ResponseWriter, r *http.Request, handler *gcHandler, gameID string) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req ChatMessageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, fmt.Sprintf("Invalid request: %v", err), http.StatusBadRequest)
		return
	}

	if handler.dota == nil || handler.currentLobbyID == 0 {
		http.Error(w, "Lobby not available", http.StatusBadRequest)
		return
	}

	// Send message to lobby chat
	// Lobby channel ID is typically the lobby ID
	handler.dota.SendChannelMessage(handler.currentLobbyID, req.Message)

	log.Printf("[Game %s] Sent chat message: %s", gameID, req.Message)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "sent"})
}

func handleDeleteGame(w http.ResponseWriter, r *http.Request, handler *gcHandler, gameID string) {
	// Cancel context to stop all operations
	handler.cancel()

	// Leave lobby before logging out (like Python)
	if handler.dota != nil && handler.currentLobbyID != 0 {
		log.Printf("[Game %s] Leaving lobby %d before deletion", gameID, handler.currentLobbyID)
		handler.dota.LeaveLobby()
		handler.dota.AbandonLobby()
		time.Sleep(500 * time.Millisecond)
	}

	// Logout and disconnect Steam client (like Python's steam.logout() and steam.disconnect())
	// CRITICAL: Must logout before disconnect to prevent leftover sessions
	if handler.client != nil {
		log.Printf("[Game %s] Logging out and disconnecting from Steam", gameID)
		handler.client.Disconnect()
		time.Sleep(1 * time.Second) // Give it time to complete logout
	}

	// Release account back to pool
	if accountPool != nil && handler.accountIndex >= 0 {
		accountPool.Release(handler.accountIndex, gameID)
	}

	// Remove from manager
	gameManager.RemoveGame(gameID)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "deleted"})
}

func handleListGames(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	games := gameManager.GetAllGames()
	statuses := make([]GameStatus, 0, len(games))

	for _, handler := range games {
		handler.membersMutex.Lock()
		radiantCount := 0
		direCount := 0
		for _, member := range handler.lobbyMembers {
			if member.Team == DOTA_GC_TEAM_GOOD_GUYS {
				radiantCount++
			} else if member.Team == DOTA_GC_TEAM_BAD_GUYS {
				direCount++
			}
		}
		handler.membersMutex.Unlock()

		handler.pollingMutex.Lock()
		pollingActive := handler.pollingActive
		pollingDone := handler.pollingDone
		handler.pollingMutex.Unlock()

		status := GameStatus{
			GameID:        handler.gameID,
			State:         handler.getState(),
			LobbyID:       handler.currentLobbyID,
			GameMode:      handler.gameConfig.GameMode,
			ServerRegion:  handler.gameConfig.ServerRegion,
			AllowCheats:   handler.gameConfig.AllowCheats,
			RadiantCount:  radiantCount,
			DireCount:     direCount,
			RadiantTeam:   handler.gameConfig.RadiantTeam,
			DireTeam:      handler.gameConfig.DireTeam,
			PollingActive: pollingActive,
			PollingDone:   pollingDone,
			PassKey:       handler.gameConfig.PassKey,
		}

		if err := handler.getError(); err != "" {
			status.Error = err
		}

		statuses = append(statuses, status)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(statuses)
}

// notifyPollingStarted notifies Master_Bot that polling should be triggered
func (h *gcHandler) notifyPollingStarted() {
	if h.pollCallbackURL == "" {
		return
	}

	reqBody := map[string]interface{}{
		"game_id": h.gameID,
		"action":  "start_poll",
	}

	jsonData, err := json.Marshal(reqBody)
	if err != nil {
		log.Printf("[Game %s] Failed to marshal polling notification: %v", h.gameID, err)
		return
	}

	resp, err := http.Post(h.pollCallbackURL, "application/json", bytes.NewBuffer(jsonData))
	if err != nil {
		log.Printf("[Game %s] Failed to notify polling start: %v", h.gameID, err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		log.Printf("[Game %s] Polling notification returned status: %d", h.gameID, resp.StatusCode)
	}
}

// notifyLobbyReady notifies Master_Bot that the lobby has been established
func (h *gcHandler) notifyLobbyReady() {
	h.lobbyReadyMutex.Lock()
	defer h.lobbyReadyMutex.Unlock()

	// Only notify if we have a valid lobby ID
	if h.currentLobbyID == 0 {
		log.Printf("[Game %s] Cannot notify lobby ready - lobbyID is 0", h.gameID)
		return
	}

	if h.lobbyReadyNotified {
		log.Printf("[Game %s] Lobby ready already notified, skipping", h.gameID)
		return
	}

	if h.lobbyReadyURL == "" {
		log.Printf("[Game %s] Cannot notify lobby ready - lobbyReadyURL is empty", h.gameID)
		return
	}

	h.lobbyReadyNotified = true

	reqBody := map[string]interface{}{
		"game_id":  h.gameID,
		"lobby_id": h.currentLobbyID,
		"pass_key": h.gameConfig.PassKey,
	}

	jsonData, err := json.Marshal(reqBody)
	if err != nil {
		log.Printf("[Game %s] Failed to marshal lobby ready notification: %v", h.gameID, err)
		return
	}

	log.Printf("[Game %s] Calling notifyLobbyReady: URL=%s, lobbyID=%d, gameID=%s", h.gameID, h.lobbyReadyURL, h.currentLobbyID, h.gameID)

	resp, err := http.Post(h.lobbyReadyURL, "application/json", bytes.NewBuffer(jsonData))
	if err != nil {
		log.Printf("[Game %s] Failed to notify lobby ready: %v", h.gameID, err)
		return
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		log.Printf("[Game %s] Lobby ready notification returned status: %d, body: %s", h.gameID, resp.StatusCode, string(body))
	} else {
		log.Printf("[Game %s] Successfully notified Master_Bot that lobby is ready (lobby_id=%d, status=%d)", h.gameID, h.currentLobbyID, resp.StatusCode)
	}
}

func (h *gcHandler) notifyGameStarted(matchID uint64) {
	h.gameStartedMutex.Lock()
	defer h.gameStartedMutex.Unlock()

	// Only notify if we have a valid match ID
	if matchID == 0 {
		log.Printf("[Game %s] Cannot notify game started - matchID is 0", h.gameID)
		return
	}

	if h.gameStartedNotified {
		log.Printf("[Game %s] Game started already notified, skipping", h.gameID)
		return
	}

	if h.gameStartedURL == "" {
		log.Printf("[Game %s] Cannot notify game started - gameStartedURL is empty", h.gameID)
		return
	}

	h.gameStartedNotified = true

	reqBody := map[string]interface{}{
		"game_id":  h.gameID,
		"match_id": matchID,
		"lobby_id": h.currentLobbyID,
	}

	jsonData, err := json.Marshal(reqBody)
	if err != nil {
		log.Printf("[Game %s] Failed to marshal game started notification: %v", h.gameID, err)
		return
	}

	log.Printf("[Game %s] Calling notifyGameStarted: URL=%s, matchID=%d, lobbyID=%d", h.gameID, h.gameStartedURL, matchID, h.currentLobbyID)

	resp, err := http.Post(h.gameStartedURL, "application/json", bytes.NewBuffer(jsonData))
	if err != nil {
		log.Printf("[Game %s] Failed to notify game started: %v", h.gameID, err)
		return
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		log.Printf("[Game %s] Game started notification returned status: %d, body: %s", h.gameID, resp.StatusCode, string(body))
	} else {
		log.Printf("[Game %s] Successfully notified Master_Bot that game started (match_id=%d, status=%d)", h.gameID, matchID, resp.StatusCode)
	}
}

// sendResultToMasterBot sends game result to the master bot via HTTP POST
func (h *gcHandler) sendResultToMasterBot(result *GameResult) error {
	if h.gameConfig.ResultURL == "" {
		return fmt.Errorf("ResultURL is not set")
	}

	resultJSON, err := json.Marshal(result)
	if err != nil {
		return fmt.Errorf("failed to marshal result: %v", err)
	}

	log.Printf("[Game %s] Sending result to %s: MatchID=%d, Outcome=%d", h.gameID, h.gameConfig.ResultURL, result.MatchID, result.Outcome)

	resp, err := http.Post(h.gameConfig.ResultURL, "application/json",
		bytes.NewBuffer(resultJSON))
	if err != nil {
		return fmt.Errorf("failed to POST result: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("unexpected status code: %d, response: %s", resp.StatusCode, string(body))
	}

	log.Printf("[Game %s] Successfully sent result to master bot (status: %d)", h.gameID, resp.StatusCode)
	return nil
}

// teardownGame cleans up the game handler after completion
func (h *gcHandler) teardownGame() {
	log.Printf("[Game %s] Tearing down game handler", h.gameID)

	// Stop keepalive
	h.stopGCKeepalive()

	// Leave lobby before logging out (like Python's dota.leave_practice_lobby())
	if h.dota != nil && h.currentLobbyID != 0 {
		log.Printf("[Game %s] Leaving lobby %d before teardown", h.gameID, h.currentLobbyID)
		h.dota.LeaveLobby()
		h.dota.AbandonLobby()
		time.Sleep(500 * time.Millisecond) // Brief wait for leave to process
	}

	// Cancel context (this will also stop the keepalive goroutine)
	h.cancel()

	// Logout and disconnect Steam client (like Python's steam.logout() and steam.disconnect())
	// CRITICAL: Must logout before disconnect to prevent leftover sessions blocking future connections
	if h.client != nil {
		// Try to logout first (like Python's steam.logout())
		// Note: go-steam may not have explicit LogOff, but Disconnect should handle it
		// However, we should ensure we're properly logged out
		log.Printf("[Game %s] Logging out and disconnecting from Steam", h.gameID)
		h.client.Disconnect() // This should handle logout internally
		// Give it a moment to complete
		time.Sleep(1 * time.Second)
	}

	// Release account back to pool
	if accountPool != nil && h.accountIndex >= 0 {
		accountPool.Release(h.accountIndex, h.gameID)
	}

	// Remove from manager
	gameManager.RemoveGame(h.gameID)

	h.setState("completed")
	log.Printf("[Game %s] Game handler torn down", h.gameID)
}

func (h *gcHandler) handleUpdateMultiple(payload []byte) {
	var updateMsg protocol.CMsgSOMultipleObjects
	if err := proto.Unmarshal(payload, &updateMsg); err != nil {
		return
	}

	const LobbyTypeID = 2004
	// Note: We're using cache subscription for lobby events now, so we don't process lobbies here
	// to avoid duplicate processing. Only process non-lobby objects in UpdateMultiple.
	// Silently skip lobby objects - they're handled by cache subscription
	for _, obj := range updateMsg.GetObjectsAdded() {
		_ = obj // Lobbies handled by cache subscription
	}
	for _, obj := range updateMsg.GetObjectsModified() {
		_ = obj // Lobbies handled by cache subscription
	}
}

func (h *gcHandler) parseCSODOTALobbyFromObjectData(objectData []byte, isNewLobby bool) {
	var lobby protocol.CSODOTALobby
	if err := proto.Unmarshal(objectData, &lobby); err != nil {
		return
	}

	state := lobby.GetState()
	gameState := lobby.GetGameState()
	lobbyID := lobby.GetLobbyId()
	passKeyFromLobby := lobby.GetPassKey()
	serverRegion := lobby.GetServerRegion()
	allowCheats := lobby.GetAllowCheats()
	gameName := lobby.GetGameName()

	if lobbyID != 0 {
		// Check if this is the first time we're seeing this lobby ID
		// (regardless of whether it came as "added" or "modified" - GC cache might send it as modified)
		wasLobbyIDZero := h.currentLobbyID == 0
		isNewLobbyForThisGame := wasLobbyIDZero || h.currentLobbyID != lobbyID

		// Only process if this is a new lobby for this game instance
		if isNewLobbyForThisGame {
			log.Printf("[Game %s] New lobby detected: ID=%d, PassKey=%s, GameName=%s",
				h.gameID, lobbyID, passKeyFromLobby, gameName)

			// If we had a different lobby ID, we're switching to a new lobby
			if !wasLobbyIDZero && h.currentLobbyID != lobbyID {
				log.Printf("[Game %s] Switching from lobby %d to lobby %d", h.gameID, h.currentLobbyID, lobbyID)
				// Reset invite flag and invited players when switching lobbies
				h.invitesMutex.Lock()
				h.invitesSent = false
				h.invitesMutex.Unlock()
				h.playersInvitedMutex.Lock()
				h.playersInvited = make(map[uint64]bool) // Clear invited players for new lobby
				h.playersInvitedMutex.Unlock()
			}

			h.currentLobbyID = lobbyID

			// Send invites when we first receive the lobby ID (first time currentLobbyID transitions from 0 to non-zero)
			// This handles both "added" and "modified" cases, since GC might send it as modified if it's in cache
			if wasLobbyIDZero {
				// Check if we should send invites (first time we get a lobby ID and haven't sent invites yet)
				h.invitesMutex.Lock()
				shouldSendInvites := !h.invitesSent && h.currentLobbyID != 0
				if shouldSendInvites {
					// Set this immediately to prevent duplicate invites if called multiple times
					h.invitesSent = true
				}
				h.invitesMutex.Unlock()

				if shouldSendInvites {
					h.setState("waiting")
					// Notify Master_Bot that lobby is ready (only when we have a valid lobbyID)
					// This must be called when we first receive the lobby ID
					h.notifyLobbyReady()

					// Send invites when lobby is first created (equivalent to lobby_new event in Python)
					// Wait a short time for GC to be fully ready
					// Capture the lobby ID to avoid race conditions
					lobbyIDForInvites := lobbyID
					go func() {
						time.Sleep(2 * time.Second)
						log.Printf("[Game %s] Sending invites for lobby ID %d", h.gameID, lobbyIDForInvites)
						// Verify lobby ID is still valid before sending
						if h.currentLobbyID == lobbyIDForInvites {
							h.sendInvitesToPlayers()
						} else {
							log.Printf("[Game %s] Skipping invites - lobby ID changed from %d to %d", h.gameID, lobbyIDForInvites, h.currentLobbyID)
						}
					}()
				}
			}
		}
		// Silently ignore duplicate lobby updates (same lobby ID)

		// State transition if we're still creating AND we have a valid lobby ID
		// (This handles cases where state wasn't already updated above)
		if h.getState() == "creating" && lobbyID != 0 {
			h.setState("waiting")
			// Notify Master_Bot that lobby is ready (only when we have a valid lobbyID)
			// Note: This is a fallback in case notifyLobbyReady wasn't called above
			h.notifyLobbyReady()
		}
	} else {
		log.Printf("[Game %s] Received lobby object but lobbyID is 0", h.gameID)
	}
	if gameName != "" {
		h.currentGameName = gameName
	}

	if h.lastKnownAllowCheats == nil || *h.lastKnownAllowCheats != allowCheats {
		if h.lastKnownAllowCheats == nil {
			log.Printf("[Game %s] Allow Cheats: %v", h.gameID, allowCheats)
		}
		h.lastKnownAllowCheats = &allowCheats

		if h.gameConfig != nil && h.gameConfig.AllowCheats && !allowCheats {
			if h.dota != nil && lobbyID != 0 {
				h.setAllLobbySettings()
			}
		}
	}

	stateValue := uint32(state)
	if stateValue != h.lastKnownState {
		h.lastKnownState = stateValue
	}

	isPostGame := (state == 3) || (gameState == protocol.DOTA_GameState_DOTA_GAMERULES_STATE_POST_GAME)

	if isPostGame {
		if h.gameInProgress {
			h.gameInProgress = false
			h.setState("postgame")

			matchID := lobby.GetMatchId()
			matchOutcome := lobby.GetMatchOutcome()

			if h.pendingResults == nil {
				h.pendingResults = make(map[uint64]*GameResult)
			}

			resultKey := lobbyID
			if matchID != 0 {
				resultKey = matchID
			}

			result := h.pendingResults[resultKey]
			if result == nil {
				result = &GameResult{
					GameID:       h.gameID,
					LobbyID:      lobbyID,
					MatchID:      matchID,
					GameName:     lobby.GetGameName(),
					GameMode:     lobby.GetGameMode(),
					LobbyType:    uint32(lobby.GetLobbyType()),
					Outcome:      int32(matchOutcome),
					ServerRegion: h.gameConfig.ServerRegion,
					Timestamp:    time.Now(),
				}
				h.pendingResults[resultKey] = result
			} else {
				if matchID != 0 {
					result.MatchID = matchID
				}
				if matchOutcome != protocol.EMatchOutcome_k_EMatchOutcome_Unknown {
					result.Outcome = int32(matchOutcome)
				}
			}

			if matchID != 0 && matchOutcome != protocol.EMatchOutcome_k_EMatchOutcome_Unknown {
				h.processCompleteGameResult(result)
			}
		}
	}

	if serverRegion != h.lastKnownRegion {
		h.lastKnownRegion = serverRegion
		if serverRegion != h.gameConfig.ServerRegion {
			if h.dota != nil && lobbyID != 0 {
				h.setAllLobbySettings()
			}
		}
	}

	members := lobby.GetAllMembers()
	memberCount := len(members)

	if memberCount != h.lastKnownMemberCount {
		h.lastKnownMemberCount = memberCount

		// Auto-trigger polling when enough human players join.
		// Normal mode: 7 players + bot = 8 total members
		// Debug mode: 2 human players + bot = 3 total members (lower threshold for testing)
		totalExpectedPlayers := len(h.gameConfig.RadiantTeam) + len(h.gameConfig.DireTeam)
		autoPollSize := 8
		if h.gameConfig.DebugMode && totalExpectedPlayers < 10 {
			autoPollSize = 3 // 2 human players + bot
		}

		if memberCount >= autoPollSize && state == 0 { // UI state
			h.pollingMutex.Lock()
			if !h.pollingDone && !h.pollCallbackSent && h.pollCallbackURL != "" {
				h.pollCallbackSent = true
				h.pollingMutex.Unlock()

				// Notify Master_Bot to start polling.
				// pollingActive will be set when Master_Bot confirms via /poll/{id} with action "start".
				go h.notifyPollingStarted()
				log.Printf("[Game %s] Lobby has %d members (threshold=%d, debug=%v) — triggering game mode poll",
					h.gameID, memberCount, autoPollSize, h.gameConfig.DebugMode)
			} else {
				h.pollingMutex.Unlock()
			}
		}
	}

	if memberCount == 0 {
		return
	}

	h.membersMutex.Lock()
	var botSteamID uint64
	if h.client != nil {
		botSteamID = h.client.SteamId().ToUint64()
	}

	for _, member := range members {
		steamID := member.GetId()
		if steamID == 0 {
			continue
		}

		team := int32(member.GetTeam())
		lobbyMember := &LobbyMember{
			SteamID: steamID,
			Team:    team,
			Name:    "",
		}
		h.lobbyMembers[steamID] = lobbyMember

		if botSteamID != 0 && steamID == botSteamID {
			if team == DOTA_GC_TEAM_GOOD_GUYS || team == DOTA_GC_TEAM_BAD_GUYS {
				botSteamID32 := uint32(botSteamID & 0xFFFFFFFF)
				if h.dota != nil {
					h.dota.KickLobbyMemberFromTeam(botSteamID32)
					h.botMovedToUnassigned = true
				}
			}
		}
	}
	h.membersMutex.Unlock()

	if !h.botMovedToUnassigned && lobbyID != 0 && h.client != nil {
		go func() {
			time.Sleep(2 * time.Second)
			h.moveBotToUnassigned()
		}()
	}

	go h.checkTeamAssignmentsAndLaunch()
}

func (h *gcHandler) checkTeamAssignmentsAndLaunch() {
	h.teamCheckMutex.Lock()
	now := time.Now()
	if !h.lastTeamCheckTime.IsZero() && now.Sub(h.lastTeamCheckTime) < 1*time.Second {
		h.teamCheckMutex.Unlock()
		return
	}
	h.lastTeamCheckTime = now
	h.teamCheckMutex.Unlock()

	h.processTeamAssignments(nil)
}

func (h *gcHandler) setAllLobbySettings() {
	if h.dota == nil || h.currentLobbyID == 0 {
		return
	}

	allowCheats := h.gameConfig.AllowCheats
	gameName := h.currentGameName
	if gameName == "" {
		gameName = h.gameConfig.GameName
	}

	serverRegion := h.gameConfig.ServerRegion
	gameMode := h.gameConfig.GameMode
	fillWithBots := false
	allowSpectating := true // Allow spectators
	allChat := false
	lan := false
	passKey := h.gameConfig.PassKey
	leagueID := h.gameConfig.LeagueID

	h.dota.SetLobbyDetails(&protocol.CMsgPracticeLobbySetDetails{
		LobbyId:         &h.currentLobbyID,
		GameName:        &gameName,
		ServerRegion:    &serverRegion,
		GameMode:        &gameMode,
		AllowCheats:     &allowCheats,
		FillWithBots:    &fillWithBots,
		AllowSpectating: &allowSpectating,
		Allchat:         &allChat,
		Lan:             &lan,
		PassKey:         &passKey,
		Leagueid:        &leagueID,
	})

	log.Printf("[Game %s] Set all lobby settings: GameName=%s, Server=%d, GameMode=%d, AllowCheats=%v, PassKey=%s",
		h.gameID, gameName, serverRegion, gameMode, allowCheats, passKey)
}

func (h *gcHandler) processTeamAssignments(lobby *protocol.CMsgPracticeLobbySetDetails) {
	if h.gameConfig == nil || h.gameLaunched || h.gameInProgress {
		return
	}

	h.membersMutex.Lock()
	memberCount := len(h.lobbyMembers)
	if memberCount == 0 {
		h.membersMutex.Unlock()
		return
	}

	members := make([]*LobbyMember, 0, memberCount)
	for _, member := range h.lobbyMembers {
		members = append(members, member)
	}
	h.membersMutex.Unlock()

	radiantPlayers := make(map[uint64]bool)
	direPlayers := make(map[uint64]bool)
	wrongTeamPlayers := []uint64{}

	expectedRadiant := make(map[uint64]bool)
	expectedDire := make(map[uint64]bool)

	for _, steamID := range h.gameConfig.RadiantTeam {
		expectedRadiant[steamID] = true
	}
	for _, steamID := range h.gameConfig.DireTeam {
		expectedDire[steamID] = true
	}

	for _, member := range members {
		if member == nil {
			continue
		}

		memberID := member.SteamID
		team := member.Team

		shouldBeRadiant := expectedRadiant[memberID]
		shouldBeDire := expectedDire[memberID]

		if shouldBeRadiant {
			if team == DOTA_GC_TEAM_GOOD_GUYS {
				radiantPlayers[memberID] = true
			} else {
				// Player should be Radiant but is on wrong team
				playerName := h.getPlayerDisplayName(memberID)
				log.Printf("[Game %s] Player %s should be Radiant but is on team %d - moving to unassigned", h.gameID, playerName, team)
				wrongTeamPlayers = append(wrongTeamPlayers, memberID)
			}
		} else if shouldBeDire {
			if team == DOTA_GC_TEAM_BAD_GUYS {
				direPlayers[memberID] = true
			} else {
				// Player should be Dire but is on wrong team
				playerName := h.getPlayerDisplayName(memberID)
				log.Printf("[Game %s] Player %s should be Dire but is on team %d - moving to unassigned", h.gameID, playerName, team)
				wrongTeamPlayers = append(wrongTeamPlayers, memberID)
			}
		} else if team == DOTA_GC_TEAM_GOOD_GUYS || team == DOTA_GC_TEAM_BAD_GUYS {
			// Player is not in the match at all (not in Radiant or Dire) but is on a team - move to unassigned
			playerName := h.getPlayerDisplayName(memberID)
			log.Printf("[Game %s] Player %s is not in the match but is on team %d - moving to unassigned", h.gameID, playerName, team)
			wrongTeamPlayers = append(wrongTeamPlayers, memberID)
		}
	}

	for _, steamID := range wrongTeamPlayers {
		h.movePlayerToUnassigned(steamID)
	}

	radiantCount := len(radiantPlayers)
	direCount := len(direPlayers)

	expectedRadiantCount := len(h.gameConfig.RadiantTeam)
	expectedDireCount := len(h.gameConfig.DireTeam)

	// Check if polling just ended and players not ready
	h.pollingMutex.Lock()
	pollingJustEnded := h.pollingDone && !h.pollingActive
	h.pollingMutex.Unlock()

	if pollingJustEnded && (radiantCount < expectedRadiantCount || direCount < expectedDireCount) {
		// Polling finished but not all players seated
		if h.dota != nil && h.currentLobbyID != 0 {
			h.dota.SendChannelMessage(h.currentLobbyID, "Game polling finished, but not all players are seated. Game will launch once all players are on their assigned teams.")
		}
	}

	if radiantCount == expectedRadiantCount && direCount == expectedDireCount {
		// All players are seated - check if a poll is currently running
		h.pollingMutex.Lock()
		pollingActive := h.pollingActive
		messageAlreadySent := h.pollingMessageSent
		h.pollingMutex.Unlock()

		// Only block launch while a poll is actively running.
		// Once the poll ends (pollingActive=false), game proceeds regardless of outcome.
		if pollingActive {
			// All players ready but polling is active - send message only once
			if !messageAlreadySent {
				h.pollingMutex.Lock()
				h.pollingMessageSent = true
				h.pollingMutex.Unlock()

				log.Printf("[Game %s] All players ready but polling is active — delaying launch", h.gameID)
				if h.dota != nil && h.currentLobbyID != 0 {
					go func() {
						channelName := fmt.Sprintf("Lobby_%d", h.currentLobbyID)
						channelType := protocol.DOTAChatChannelTypeT_DOTAChannelType_Lobby

						ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
						defer cancel()

						joinResp, err := h.dota.JoinChatChannel(ctx, channelName, channelType, false)
						if err == nil && joinResp != nil && joinResp.GetResult() == protocol.CMsgDOTAJoinChatChannelResponse_JOIN_SUCCESS {
							channelID := joinResp.GetChannelId()
							if channelID != 0 {
								h.dota.SendChannelMessage(channelID, "All players are ready but game mode poll is still active.  Will start game upon completion.")
							} else {
								h.dota.SendChannelMessage(h.currentLobbyID, "All players are ready but game mode poll is still active.  Will start game upon completion.")
							}
						} else {
							h.dota.SendChannelMessage(h.currentLobbyID, "All players are ready but game mode poll is still active.  Will start game upon completion.")
						}
					}()
				}
			}
			return // Don't launch yet — poll still running
		}

		// Launch when all expected players are seated (works for any team size)
		if expectedRadiantCount > 0 && expectedDireCount > 0 {
			log.Printf("[Game %s] All players assigned (%d Radiant, %d Dire) - launching", h.gameID, expectedRadiantCount, expectedDireCount)
			h.launchGame()
		}
	}
}

// getPlayerDisplayName returns a formatted string with player name and Steam ID for logging
func (h *gcHandler) getPlayerDisplayName(steamID uint64) string {
	h.membersMutex.Lock()
	defer h.membersMutex.Unlock()

	if member, exists := h.lobbyMembers[steamID]; exists && member.Name != "" {
		return fmt.Sprintf("%s (%d)", member.Name, steamID)
	}
	return fmt.Sprintf("%d", steamID)
}

func (h *gcHandler) movePlayerToUnassigned(steamID uint64) {
	steamID32 := uint32(steamID & 0xFFFFFFFF)
	if h.dota != nil {
		h.dota.KickLobbyMemberFromTeam(steamID32)
	}
}

func (h *gcHandler) launchGame() {
	if h.gameLaunched {
		return
	}

	if h.dota == nil {
		return
	}

	// Block launch while a game mode poll is actively running
	h.pollingMutex.Lock()
	pollingActive := h.pollingActive
	h.pollingMutex.Unlock()

	if pollingActive {
		log.Printf("[Game %s] Cannot launch — game mode poll is still active", h.gameID)
		return
	}

	h.setState("launching")
	log.Printf("[Game %s] Launching game", h.gameID)

	h.setAllLobbySettings()
	time.Sleep(500 * time.Millisecond)

	h.dota.LaunchLobby()
	h.gameLaunched = true
	h.gameInProgress = true
	h.setState("in_progress")
}

// sendInvitesToPlayers sends Steam invites to all players in both teams
// Note: h.invitesSent should be set to true before calling this function
func (h *gcHandler) sendInvitesToPlayers() {
	log.Printf("[Game %s] DEBUG: sendInvitesToPlayers() called", h.gameID)

	if h.dota == nil {
		log.Printf("[Game %s] Cannot send invites: dota client is nil", h.gameID)
		// Retry after delay
		go func() {
			time.Sleep(3 * time.Second)
			h.invitesMutex.Lock()
			h.invitesSent = false
			h.invitesMutex.Unlock()
			h.sendInvitesToPlayers()
		}()
		return
	}

	if h.currentLobbyID == 0 {
		log.Printf("[Game %s] Cannot send invites: lobbyID is 0", h.gameID)
		// Retry after delay
		go func() {
			time.Sleep(3 * time.Second)
			h.invitesMutex.Lock()
			h.invitesSent = false
			h.invitesMutex.Unlock()
			h.sendInvitesToPlayers()
		}()
		return
	}

	// Collect all Steam IDs to invite
	allSteamIDs := make([]uint64, 0)
	allSteamIDs = append(allSteamIDs, h.gameConfig.RadiantTeam...)
	allSteamIDs = append(allSteamIDs, h.gameConfig.DireTeam...)

	if len(allSteamIDs) == 0 {
		log.Printf("[Game %s] No players to invite", h.gameID)
		return
	}

	log.Printf("[Game %s] Sending invites to %d players (lobbyID=%d)", h.gameID, len(allSteamIDs), h.currentLobbyID)

	// Get lobby password for messages
	passKey := h.gameConfig.PassKey
	if passKey == "" {
		passKey = "No password"
	}

	// Send invites and Steam messages
	for _, steamID64 := range allSteamIDs {
		if steamID64 == 0 {
			continue
		}

		// Check if we've already invited this player for this lobby
		h.playersInvitedMutex.Lock()
		if h.playersInvited[steamID64] {
			h.playersInvitedMutex.Unlock()
			playerName := h.getPlayerDisplayName(steamID64)
			log.Printf("[Game %s] Skipping invite to %s - already invited for this lobby", h.gameID, playerName)
			continue
		}
		h.playersInvited[steamID64] = true
		h.playersInvitedMutex.Unlock()

		steamID := steamid.SteamId(steamID64)

		// Send invite directly
		playerName := h.getPlayerDisplayName(steamID64)
		if h.dota != nil {
			h.dota.InviteLobbyMember(steamID)
			log.Printf("[Game %s] Sent invite to %s", h.gameID, playerName)
		} else {
			log.Printf("[Game %s] ERROR: Cannot send invite to %s - dota client is nil", h.gameID, playerName)
		}

		// Send Steam friend message with password
		if h.client != nil {
			// Add as friend and send message (in background, don't block)
			go func(sid steamid.SteamId, sid64 uint64) {
				message := fmt.Sprintf("Invited to 'Gargamel League Game %s'. Password: %s", h.gameID, passKey)

				// Add as friend first (idempotent - safe to call even if already a friend)
				// This ensures they're added if they weren't already, and won't cause issues if they were
				h.client.Social.AddFriend(sid)

				// Wait a bit for friend request to be processed (if it was needed)
				time.Sleep(1 * time.Second)

				// Send message once (only after ensuring friend status)
				h.client.Social.SendMessage(sid, steamlang.EChatEntryType_ChatMsg, message)
				playerName := h.getPlayerDisplayName(sid64)
				log.Printf("[Game %s] Sent Steam message with password to %s", h.gameID, playerName)
			}(steamID, steamID64)
		} else {
			playerName := h.getPlayerDisplayName(steamID64)
			log.Printf("[Game %s] ERROR: Cannot send Steam message to %s - client is nil", h.gameID, playerName)
		}
	}

	log.Printf("[Game %s] Finished sending invites and messages", h.gameID)
}

func (h *gcHandler) moveBotToUnassigned() {
	if h.botMovedToUnassigned || h.client == nil || h.dota == nil {
		return
	}

	botSteamID := h.client.SteamId()
	if botSteamID == 0 {
		return
	}

	botSteamID32 := uint32(botSteamID.ToUint64() & 0xFFFFFFFF)
	h.dota.KickLobbyMemberFromTeam(botSteamID32)
	h.botMovedToUnassigned = true
}

func (h *gcHandler) handleLobbyUpdate(payload []byte) {
	var lobby protocol.CMsgPracticeLobbySetDetails
	if err := proto.Unmarshal(payload, &lobby); err != nil {
		return
	}

	lobbyID := lobby.GetLobbyId()
	if lobbyID != 0 {
		h.currentLobbyID = lobbyID

		// State transition if we're still creating
		if h.getState() == "creating" {
			h.setState("waiting")
		}

		h.setAllLobbySettings()
	}

	if !h.botMovedToUnassigned && lobbyID != 0 && h.client != nil {
		go func() {
			time.Sleep(2 * time.Second)
			h.moveBotToUnassigned()
		}()
	}

	h.processTeamAssignments(&lobby)
}

func (h *gcHandler) tryParseAsMatchDetails(payload []byte, msgType uint32) {
	var matchDetailsResponse protocol.CMsgGCMatchDetailsResponse
	if err := proto.Unmarshal(payload, &matchDetailsResponse); err == nil {
		if matchDetailsResponse.Match != nil && matchDetailsResponse.Match.GetMatchId() != 0 {
			h.processMatchInfo(matchDetailsResponse.Match)
			return
		}
	}

	var match protocol.CMsgDOTAMatch
	if err := proto.Unmarshal(payload, &match); err == nil {
		matchID := match.GetMatchId()
		if matchID != 0 {
			duration := match.GetDuration()
			startTime := match.GetStarttime()
			matchOutcome := match.GetMatchOutcome()
			if duration > 0 || startTime > 0 || matchOutcome != 0 {
				h.processMatchInfo(&match)
			}
		}
	}
}

func (h *gcHandler) handleMatchDetails(payload []byte) {
	var matchDetails protocol.CMsgGCMatchDetailsResponse
	if err := proto.Unmarshal(payload, &matchDetails); err != nil {
		return
	}

	if matchDetails.Match != nil {
		h.processMatchInfo(matchDetails.Match)
	}
}

func (h *gcHandler) processMatchInfo(match *protocol.CMsgDOTAMatch) {
	h.resultsMutex.Lock()
	defer h.resultsMutex.Unlock()

	matchID := match.GetMatchId()

	// Notify game started if we have a match ID and game is in progress
	if matchID != 0 && h.gameInProgress {
		// Call notifyGameStarted outside the mutex to avoid deadlock
		h.resultsMutex.Unlock()
		h.notifyGameStarted(matchID)
		h.resultsMutex.Lock()
	}

	if h.gameInProgress {
		h.gameInProgress = false
	}

	var pendingResult *GameResult
	if len(h.pendingResults) > 0 {
		for _, pr := range h.pendingResults {
			if pendingResult == nil || pr.Timestamp.After(pendingResult.Timestamp) {
				pendingResult = pr
			}
		}
	}

	if pendingResult == nil {
		// Create new result, preserving lobby info from handler state
		pendingResult = &GameResult{
			GameID:       h.gameID,
			MatchID:      matchID,
			LobbyID:      h.currentLobbyID,
			GameName:     h.currentGameName,
			Duration:     match.GetDuration(),
			Outcome:      int32(match.GetMatchOutcome()),
			RadiantScore: match.GetRadiantTeamScore(),
			DireScore:    match.GetDireTeamScore(),
			StartTime:    match.GetStarttime(),
			LobbyType:    match.GetLobbyType(),
			GameMode:     uint32(match.GetGameMode()),
			ServerRegion: h.gameConfig.ServerRegion,
			Timestamp:    time.Now(),
		}
		log.Printf("[Game %s] Created new result from match info: MatchID=%d, LobbyID=%d, Outcome=%d",
			h.gameID, matchID, h.currentLobbyID, match.GetMatchOutcome())
	} else {
		// Update existing result with match details
		pendingResult.MatchID = matchID
		pendingResult.Duration = match.GetDuration()
		pendingResult.Outcome = int32(match.GetMatchOutcome())
		pendingResult.RadiantScore = match.GetRadiantTeamScore()
		pendingResult.DireScore = match.GetDireTeamScore()
		pendingResult.StartTime = match.GetStarttime()
		pendingResult.LobbyType = match.GetLobbyType()
		pendingResult.GameMode = uint32(match.GetGameMode())
		// Preserve LobbyID and GameName if not already set
		if pendingResult.LobbyID == 0 {
			pendingResult.LobbyID = h.currentLobbyID
		}
		if pendingResult.GameName == "" {
			pendingResult.GameName = h.currentGameName
		}
		log.Printf("[Game %s] Updated existing result from match info: MatchID=%d, Outcome=%d",
			h.gameID, matchID, match.GetMatchOutcome())
	}

	h.processCompleteGameResult(pendingResult)
}

func (h *gcHandler) getOutcomeString(outcome int32) string {
	switch outcome {
	case 2:
		return "Radiant Victory"
	case 3:
		return "Dire Victory"
	default:
		return "Unknown"
	}
}

func (h *gcHandler) processCompleteGameResult(result *GameResult) {
	// Check if result has already been sent
	h.resultSentMutex.Lock()
	if h.resultSent {
		log.Printf("[Game %s] Result already sent, skipping duplicate processing", h.gameID)
		h.resultSentMutex.Unlock()
		return
	}
	h.resultSentMutex.Unlock()

	// Validate result before processing
	if result.MatchID == 0 {
		log.Printf("[Game %s] WARNING: Cannot process result - MatchID is 0", h.gameID)
		return
	}

	if result.Outcome == 0 || result.Outcome == int32(protocol.EMatchOutcome_k_EMatchOutcome_Unknown) {
		log.Printf("[Game %s] WARNING: Cannot process result - Outcome is Unknown (value: %d)", h.gameID, result.Outcome)
		return
	}

	log.Printf("[Game %s] Processing complete game result: MatchID=%d, LobbyID=%d, Outcome=%d, Duration=%d, RadiantScore=%d, DireScore=%d",
		h.gameID, result.MatchID, result.LobbyID, result.Outcome, result.Duration, result.RadiantScore, result.DireScore)

	// Mark as sent before sending to prevent duplicates
	h.resultSentMutex.Lock()
	h.resultSent = true
	h.resultSentMutex.Unlock()

	// Send result to master bot
	if err := h.sendResultToMasterBot(result); err != nil {
		log.Printf("[Game %s] Error sending result to master bot: %v", h.gameID, err)
		// Still teardown even if send fails
	} else {
		log.Printf("[Game %s] Successfully sent result to master bot", h.gameID)
	}

	// Teardown the game handler
	h.teardownGame()
}

func createDotaLobby(ctx context.Context, handler *gcHandler, config *GameConfig) error {
	log.Printf("[Game %s] createDotaLobby: Starting...", config.GameID)
	logger := logrus.New()

	log.Printf("[Game %s] createDotaLobby: Creating Steam client...", config.GameID)
	client := steam.NewClient()
	if client == nil {
		err := fmt.Errorf("failed to create Steam client")
		log.Printf("[Game %s] ERROR: %v", config.GameID, err)
		return err
	}

	log.Printf("[Game %s] createDotaLobby: Connecting to Steam...", config.GameID)
	handler.client = client

	// Fetch live Steam CM server list from Steam's API before connecting.
	// Without this, Connect() falls back to a hardcoded static list that may contain
	// dead/unreachable servers (causing "no route to host" errors).
	if err := steam.InitializeSteamDirectory(); err != nil {
		log.Printf("[Game %s] Warning: failed to initialize Steam directory (will use static server list): %v", config.GameID, err)
	} else {
		log.Printf("[Game %s] Steam directory initialized with live server list", config.GameID)
	}

	log.Printf("[Game %s] Using account %s (index %d)", config.GameID, config.Username, handler.accountIndex)

	var gcInitialized bool
	var lobbyCreated bool
	var connectionRetries int
	const maxConnectionRetries = 15
	retryDelay := 2 * time.Second
	var connectionTimeout time.Duration = 30 * time.Second
	var lastConnectionAttempt time.Time
	var retrying bool // guards against concurrent retry attempts

	// Start event loop in background - it must keep running
	// The event loop must continue running to maintain the Steam connection
	go func() {
		defer func() {
			if r := recover(); r != nil {
				log.Printf("[Game %s] PANIC in Steam event loop: %v", config.GameID, r)
				handler.setError(fmt.Sprintf("Panic in event loop: %v", r))
				// Release account on panic
				if accountPool != nil && handler.accountIndex >= 0 {
					accountPool.Release(handler.accountIndex, config.GameID)
					log.Printf("[Game %s] Released account %d due to event loop panic", config.GameID, handler.accountIndex)
				}
			}
		}()

		log.Printf("[Game %s] Steam event loop started", config.GameID)

		// Start connection attempt (non-blocking, like Python's steam.login)
		// The Python library uses steam.login() which is non-blocking and handles connection internally
		lastConnectionAttempt = time.Now()
		client.Connect()
		log.Printf("[Game %s] Steam connection attempt initiated", config.GameID)

		// Note: Unlike Python's steam library which has built-in reconnect logic,
		// go-steam requires manual reconnection handling. We handle this via event listeners.

		// Set up connection timeout check
		connectionTimeoutTicker := time.NewTicker(5 * time.Second)
		defer connectionTimeoutTicker.Stop()

		eventCount := 0
		connected := false

		for {
			select {
			case <-ctx.Done():
				log.Printf("[Game %s] Context cancelled, shutting down Steam client", config.GameID)
				// Leave lobby if it exists before disconnecting (like Python)
				if handler.dota != nil && handler.currentLobbyID != 0 {
					handler.dota.LeaveLobby()
					handler.dota.AbandonLobby()
				}
				// Logout and disconnect (like Python's steam.logout() and steam.disconnect())
				client.Disconnect()
				return

			case <-connectionTimeoutTicker.C:
				// Check if we've been trying to connect for too long without success.
				// Skip if the error/disconnect handler is already performing a retry.
				if !connected && !retrying && !lastConnectionAttempt.IsZero() {
					elapsed := time.Since(lastConnectionAttempt)
					if elapsed > connectionTimeout {
						retrying = true
						connectionRetries++
						if connectionRetries <= maxConnectionRetries {
							log.Printf("[Game %s] Connection timeout after %v (attempt %d/%d), retrying with new server...",
								config.GameID, elapsed, connectionRetries, maxConnectionRetries)
							client.Disconnect()
							time.Sleep(retryDelay)
							lastConnectionAttempt = time.Now()
							client.Connect()
							if retryDelay < 30*time.Second {
								retryDelay *= 2
							}
						} else {
							log.Printf("[Game %s] Connection failed after %d retries, giving up", config.GameID, maxConnectionRetries)
							handler.setError(fmt.Sprintf("Failed to connect to Steam after %d retries", maxConnectionRetries))
							if accountPool != nil && handler.accountIndex >= 0 {
								accountPool.Release(handler.accountIndex, config.GameID)
							}
							return
						}
						retrying = false
					}
				}

			case event, ok := <-client.Events():
				if !ok {
					log.Printf("[Game %s] Steam event channel closed", config.GameID)
					return
				}

				eventCount++
				if eventCount <= 5 || eventCount%50 == 0 {
					log.Printf("[Game %s] Steam event #%d: %T", config.GameID, eventCount, event)
				}

				switch e := event.(type) {
				case *steam.ConnectedEvent:
					connected = true
					log.Printf("[Game %s] Connected to Steam, logging in...", config.GameID)
					// Reset retry state on successful connection
					connectionRetries = 0
					retryDelay = 2 * time.Second
					retrying = false
					lastConnectionAttempt = time.Time{} // Clear timeout
					client.Auth.LogOn(&steam.LogOnDetails{
						Username: config.Username,
						Password: config.Password,
					})

				case *steam.LoggedOnEvent:
					log.Printf("[Game %s] Logged in to Steam", config.GameID)
					client.Social.SetPersonaState(steamlang.EPersonaState_Online)
					client.GC.SetGamesPlayed(570)

				case *steam.PersonaStateEvent:
					// Update player names when we receive persona state updates
					if e.FriendId != 0 {
						handler.membersMutex.Lock()
						if member, exists := handler.lobbyMembers[e.FriendId.ToUint64()]; exists {
							if e.Name != "" {
								member.Name = e.Name
							}
						}
						handler.membersMutex.Unlock()
					}

					// Initialize Dota client after login
					if !gcInitialized {
						gcInitialized = true
						go func() {
							// Reduced wait - GC should be ready quickly after login
							time.Sleep(2 * time.Second)
							log.Printf("[Game %s] Initializing Dota 2 client...", config.GameID)
							dota := dota2.New(client, logger)
							handler.dota = dota
							client.GC.RegisterPacketHandler(handler)

							// Subscribe to lobby cache events to detect when lobby is created
							lobbyEventCh, lobbyEventCancel, err := dota.GetCache().SubscribeType(cso.Lobby)
							if err != nil {
								log.Printf("[Game %s] Failed to subscribe to lobby cache events: %v", config.GameID, err)
							} else {
								log.Printf("[Game %s] Subscribed to lobby cache events", config.GameID)
								// Handle lobby cache events in background
								go func() {
									defer lobbyEventCancel()
									for event := range lobbyEventCh {
										if event == nil {
											continue
										}
										lobby, ok := event.Object.(*protocol.CSODOTALobby)
										if !ok {
											continue
										}

										lobbyID := lobby.GetLobbyId()
										if lobbyID == 0 {
											continue
										}

										// Handle lobby destruction
										if event.EventType == socache.EventTypeDestroy {
											// Only reset if this is the lobby we're currently tracking
											if handler.currentLobbyID == lobbyID {
												log.Printf("[Game %s] Lobby %d was destroyed, resetting state", config.GameID, lobbyID)
												handler.currentLobbyID = 0
												handler.invitesMutex.Lock()
												handler.invitesSent = false
												handler.invitesMutex.Unlock()
											}
											continue
										}

										// Filter: Only process lobbies that match this game's name
										// This prevents processing old lobbies from previous games
										expectedGameName := fmt.Sprintf("Gargamel League Game %s", config.GameID)
										lobbyGameName := lobby.GetGameName()
										if lobbyGameName != expectedGameName {
											log.Printf("[Game %s] Ignoring lobby %d - game name mismatch: expected '%s', got '%s'",
												config.GameID, lobbyID, expectedGameName, lobbyGameName)
											continue
										}

										// Only log Create events, not every Update event
										if event.EventType == socache.EventTypeCreate {
											log.Printf("[Game %s] Lobby cache event: Type=Create, LobbyID=%d, GameName=%s",
												config.GameID, lobbyID, lobbyGameName)
										}

										// Process the lobby update (Create or Update)
										objectData, err := proto.Marshal(lobby)
										if err == nil {
											isNew := event.EventType == socache.EventTypeCreate
											handler.parseCSODOTALobbyFromObjectData(objectData, isNew)
										}
									}
								}()
							}

							dota.SetPlaying(true)
							time.Sleep(500 * time.Millisecond) // Reduced from 1s
							dota.SayHello()
							time.Sleep(1 * time.Second) // Reduced from 3s - wait for GC to acknowledge

							// Leave any existing lobbies before creating a new one
							log.Printf("[Game %s] Leaving any existing lobbies before creating new one...", config.GameID)
							dota.AbandonLobby()
							dota.LeaveLobby()
							// Reset lobby ID and invite flag so we know when a new lobby is created
							handler.currentLobbyID = 0
							handler.invitesMutex.Lock()
							handler.invitesSent = false
							handler.invitesMutex.Unlock()
							handler.playersInvitedMutex.Lock()
							handler.playersInvited = make(map[uint64]bool) // Clear invited players
							handler.playersInvitedMutex.Unlock()
							time.Sleep(500 * time.Millisecond) // Reduced from 2s - minimal wait for leave to process

							// Create lobby - only if we don't already have one
							if !lobbyCreated && handler.currentLobbyID == 0 {
								lobbyCreated = true
								log.Printf("[Game %s] Creating lobby...", config.GameID)
								gameName := config.GameName
								passKey := config.PassKey
								serverRegion := config.ServerRegion
								seriesType := uint32(46)
								leagueID := config.LeagueID

								cmPick := protocol.DOTA_CM_PICK_DOTA_CM_RANDOM.Enum()
								tvDelay := protocol.LobbyDotaTVDelay_LobbyDotaTV_10.Enum()
								visibility := protocol.DOTALobbyVisibility_DOTALobbyVisibility_Public.Enum()
								pausePolicy := protocol.LobbyDotaPauseSetting_LobbyDotaPauseSetting_Limited.Enum()
								selectionPriority := protocol.DOTASelectionPriorityRules_k_DOTASelectionPriorityRules_Manual.Enum()

								fillWithBots := false
								allowSpectating := true // Allow spectators
								allChat := false
								lan := false

								handler.currentGameName = gameName

								// Don't set LobbyId - server will assign it
								dota.CreateLobby(&protocol.CMsgPracticeLobbySetDetails{
									LobbyId:                nil,
									GameName:               &gameName,
									ServerRegion:           &serverRegion,
									CmPick:                 cmPick,
									FillWithBots:           &fillWithBots,
									AllowSpectating:        &allowSpectating,
									PassKey:                &passKey,
									Allchat:                &allChat,
									Lan:                    &lan,
									Visibility:             visibility,
									PauseSetting:           pausePolicy,
									SelectionPriorityRules: selectionPriority,
									DotaTvDelay:            tvDelay,
									SeriesType:             &seriesType,
									Leagueid:               &leagueID,
								})

								handler.lobbyShouldExist = true
								handler.setState("waiting")
								log.Printf("[Game %s] Lobby creation request sent (PassKey: %s)", config.GameID, passKey)
							}
						}()
					}

				case *devents.GCConnectionStatusChanged:
					if handler != nil {
						handler.handleConnectionStatusChange(e)
					}

				case *devents.ClientWelcomed:
					if handler != nil {
						log.Printf("[Game %s] GC Client Welcomed", config.GameID)
						// Start keepalive when GC welcomes us (session established)
						// Note: We don't leave lobbies here - ClientWelcomed fires on keepalive/heartbeat
						// Lobbies are only left once at startup when initializing the Dota client
						handler.startGCKeepalive()
						// Check if lobby needs to be recreated immediately (no delay needed)
						go func() {
							time.Sleep(500 * time.Millisecond) // Minimal delay
							handler.recreateLobbyIfNeeded()
						}()
					}

				case error:
					log.Printf("[Game %s] Steam error: %v", config.GameID, e)
					errStr := e.Error()
					if strings.Contains(errStr, "connect: no route to host") ||
						strings.Contains(errStr, "connection refused") ||
						strings.Contains(errStr, "timeout") ||
						strings.Contains(errStr, "Connect failed") ||
						strings.Contains(errStr, "use of closed network connection") {
						connected = false
						// Skip if a retry is already in progress (e.g. from timeout handler)
						if retrying {
							log.Printf("[Game %s] Connection error (already retrying, skipping): %v", config.GameID, e)
							break
						}
						retrying = true
						connectionRetries++
						if connectionRetries <= maxConnectionRetries {
							log.Printf("[Game %s] Connection error (attempt %d/%d), will retry in %v...",
								config.GameID, connectionRetries, maxConnectionRetries, retryDelay)
							client.Disconnect()
							time.Sleep(retryDelay)
							if retryDelay < 30*time.Second {
								retryDelay *= 2
							}
							lastConnectionAttempt = time.Now()
							client.Connect()
						} else {
							log.Printf("[Game %s] Connection failed after %d retries, giving up", config.GameID, maxConnectionRetries)
							handler.setError(fmt.Sprintf("Failed to connect to Steam after %d retries: %v", maxConnectionRetries, e))
							if accountPool != nil && handler.accountIndex >= 0 {
								accountPool.Release(handler.accountIndex, config.GameID)
							}
							return
						}
						retrying = false
					} else {
						handler.setError(fmt.Sprintf("Steam error: %v", e))
					}

				case *steam.DisconnectedEvent:
					log.Printf("[Game %s] Disconnected from Steam", config.GameID)
					connected = false

					if handler.currentLobbyID == 0 {
						// Skip if a retry is already in progress
						if retrying {
							log.Printf("[Game %s] Disconnected (already retrying, skipping)", config.GameID)
							break
						}
						retrying = true
						connectionRetries++
						if connectionRetries <= maxConnectionRetries {
							log.Printf("[Game %s] Disconnected (attempt %d/%d), will retry in %v...",
								config.GameID, connectionRetries, maxConnectionRetries, retryDelay)
							time.Sleep(retryDelay)
							if retryDelay < 30*time.Second {
								retryDelay *= 2
							}
							lastConnectionAttempt = time.Now()
							client.Connect()
						} else {
							log.Printf("[Game %s] Disconnected after %d retries, giving up", config.GameID, maxConnectionRetries)
							handler.setError("Disconnected from Steam after multiple retries")
							if accountPool != nil && handler.accountIndex >= 0 {
								accountPool.Release(handler.accountIndex, config.GameID)
							}
							return
						}
						retrying = false
					} else {
						log.Printf("[Game %s] Disconnected but lobby exists (ID: %d), attempting reconnect...", config.GameID, handler.currentLobbyID)
						go func() {
							time.Sleep(5 * time.Second)
							client.Connect()
							lastConnectionAttempt = time.Now()
						}()
					}
				}
			}
		}
	}()

	// Wait a bit to ensure connection starts
	time.Sleep(2 * time.Second)

	// Return immediately - event loop runs in background
	// The function should not block or break the event loop
	return nil
}

func (h *gcHandler) handleConnectionStatusChange(event *devents.GCConnectionStatusChanged) {
	oldState := event.OldState
	newState := event.NewState

	if oldState == protocol.GCConnectionStatus_GCConnectionStatus_HAVE_SESSION &&
		newState != protocol.GCConnectionStatus_GCConnectionStatus_HAVE_SESSION {
		h.reconnectMutex.Lock()
		h.reconnecting = true
		h.reconnectMutex.Unlock()

		go func() {
			time.Sleep(500 * time.Millisecond) // Reduced from 2s
			h.attemptReconnect()
		}()
	}

	if oldState != protocol.GCConnectionStatus_GCConnectionStatus_HAVE_SESSION &&
		newState == protocol.GCConnectionStatus_GCConnectionStatus_HAVE_SESSION {
		h.reconnectMutex.Lock()
		h.reconnecting = false
		h.reconnectMutex.Unlock()

		h.lastKnownState = 0
		h.lastKnownRegion = 0
		h.lastKnownMemberCount = 0
		h.currentLobbyID = 0
		h.botMovedToUnassigned = false
		h.gameLaunched = false

		// Start GC keepalive when session is established
		h.startGCKeepalive()
	}
}

func (h *gcHandler) attemptReconnect() {
	if h.dota == nil {
		return
	}

	h.reconnectMutex.Lock()
	if !h.reconnecting {
		h.reconnectMutex.Unlock()
		return
	}
	h.reconnectMutex.Unlock()

	h.dota.SetPlaying(true)
	time.Sleep(500 * time.Millisecond) // Reduced from 1s
	h.dota.SayHello()
}

// startGCKeepalive starts a goroutine that periodically sends keepalive messages
// to the Game Coordinator to prevent session timeout (60-minute issue)
func (h *gcHandler) startGCKeepalive() {
	h.keepaliveMutex.Lock()
	defer h.keepaliveMutex.Unlock()

	// Don't start if already running
	if h.keepaliveRunning {
		return
	}

	h.keepaliveRunning = true

	go func() {
		ticker := time.NewTicker(55 * time.Second) // Send keepalive every 55 seconds
		defer ticker.Stop()

		log.Printf("[Game %s] GC keepalive started", h.gameID)

		for {
			select {
			case <-h.ctx.Done():
				log.Printf("[Game %s] GC keepalive stopped (context cancelled)", h.gameID)
				h.keepaliveMutex.Lock()
				h.keepaliveRunning = false
				h.keepaliveMutex.Unlock()
				return

			case <-ticker.C:
				// Check if dota client is still available
				if h.dota == nil {
					continue
				}

				// Check if we still have an active session by checking connection status
				// We'll send keepalive as long as the handler context is active
				// The GC will reject it if session is lost, but that's okay
				select {
				case <-h.ctx.Done():
					continue
				default:
					// Send keepalive using SayHello
					// This is the same message used to establish session, safe to use as keepalive
					h.dota.SayHello()
					log.Printf("[Game %s] GC keepalive sent", h.gameID)
				}
			}
		}
	}()
}

// stopGCKeepalive stops the keepalive goroutine
func (h *gcHandler) stopGCKeepalive() {
	h.keepaliveMutex.Lock()
	defer h.keepaliveMutex.Unlock()
	h.keepaliveRunning = false
	// The goroutine will exit when context is cancelled
}

func (h *gcHandler) recreateLobbyIfNeeded() {
	if h.dota == nil {
		return
	}

	h.reconnectMutex.Lock()
	shouldExist := h.lobbyShouldExist
	h.reconnectMutex.Unlock()

	if !shouldExist || h.currentLobbyID != 0 {
		return
	}

	gameName := h.gameConfig.GameName
	passKey := h.gameConfig.PassKey
	serverRegion := h.gameConfig.ServerRegion
	seriesType := uint32(46)
	leagueID := h.gameConfig.LeagueID

	cmPick := protocol.DOTA_CM_PICK_DOTA_CM_RANDOM.Enum()
	tvDelay := protocol.LobbyDotaTVDelay_LobbyDotaTV_10.Enum()
	visibility := protocol.DOTALobbyVisibility_DOTALobbyVisibility_Public.Enum()
	pausePolicy := protocol.LobbyDotaPauseSetting_LobbyDotaPauseSetting_Limited.Enum()
	selectionPriority := protocol.DOTASelectionPriorityRules_k_DOTASelectionPriorityRules_Manual.Enum()

	fillWithBots := false
	allowSpectating := true // Allow spectators
	allChat := false
	lan := false

	h.currentGameName = gameName

	// Don't set LobbyId - server will assign it
	h.dota.CreateLobby(&protocol.CMsgPracticeLobbySetDetails{
		LobbyId:                nil,
		GameName:               &gameName,
		ServerRegion:           &serverRegion,
		CmPick:                 cmPick,
		FillWithBots:           &fillWithBots,
		AllowSpectating:        &allowSpectating,
		PassKey:                &passKey,
		Allchat:                &allChat,
		Lan:                    &lan,
		Visibility:             visibility,
		PauseSetting:           pausePolicy,
		SelectionPriorityRules: selectionPriority,
		DotaTvDelay:            tvDelay,
		SeriesType:             &seriesType,
		Leagueid:               &leagueID,
	})
}
