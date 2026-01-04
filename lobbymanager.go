package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/paralin/go-dota2"
	devents "github.com/paralin/go-dota2/events"
	"github.com/paralin/go-dota2/protocol"
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
	PollCallbackURL string   `json:"poll_callback_url,omitempty"` // Optional: URL to notify when polling should be triggered
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
}

// UpdateLobbySettingsRequest represents a request to update lobby settings
type UpdateLobbySettingsRequest struct {
	GameMode     *uint32 `json:"game_mode,omitempty"`
	ServerRegion *uint32 `json:"server_region,omitempty"`
	AllowCheats  *bool   `json:"allow_cheats,omitempty"`
	GameName     string  `json:"game_name,omitempty"`
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
	pollingMutex         sync.Mutex
	pollCallbackURL      string // URL to notify when polling should be triggered
	invitesSent          bool   // Track if invites have been sent
	invitesMutex         sync.Mutex
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
	log.Println("Starting Gargamel Lobby Manager REST API server...")

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
	if req.Username == "" || req.Password == "" {
		http.Error(w, "username and password are required", http.StatusBadRequest)
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

	config := &GameConfig{
		GameID:          req.GameID,
		Username:        req.Username,
		Password:        req.Password,
		RadiantTeam:     req.RadiantTeam,
		DireTeam:        req.DireTeam,
		ResultURL:       req.ResultURL,
		ServerRegion:    serverRegion,
		GameMode:        gameMode,
		AllowCheats:     allowCheats,
		GameName:        gameName,
		PassKey:         req.PassKey,
		DebugSteamID:    req.DebugSteamID,
		PollCallbackURL: req.PollCallbackURL,
	}

	// Create handler and start game
	ctx, cancel := context.WithCancel(context.Background())
	handler := &gcHandler{
		gameID:          req.GameID,
		gameConfig:      config,
		pendingResults:  make(map[uint64]*GameResult),
		lobbyMembers:    make(map[uint64]*LobbyMember),
		ctx:             ctx,
		cancel:          cancel,
		state:           "creating",
		pollingActive:   false,
		pollingDone:     false,
		pollCallbackURL: req.PollCallbackURL,
	}

	gameManager.AddGame(req.GameID, handler)

	// Start game creation in background
	go func() {
		if err := createDotaLobby(ctx, handler, config); err != nil {
			handler.setError(err.Error())
			log.Printf("Error creating game %s: %v", req.GameID, err)
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
		if handler.dota != nil && handler.currentLobbyID != 0 {
			handler.dota.SendChannelMessage(handler.currentLobbyID, "Game Polling has Started! Check #match-listings on Discord to Vote!!")
		}

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
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req SwapPlayersRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, fmt.Sprintf("Invalid request: %v", err), http.StatusBadRequest)
		return
	}

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

	// Must be on opposite teams
	if !((steamID1InRadiant && steamID2InDire) || (steamID1InDire && steamID2InRadiant)) {
		http.Error(w, "Players must be on opposite teams", http.StatusBadRequest)
		return
	}

	// Swap in config
	if steamID1InRadiant && steamID2InDire {
		// Remove from current teams
		for i, sid := range handler.gameConfig.RadiantTeam {
			if sid == req.SteamID1 {
				handler.gameConfig.RadiantTeam = append(handler.gameConfig.RadiantTeam[:i], handler.gameConfig.RadiantTeam[i+1:]...)
				break
			}
		}
		for i, sid := range handler.gameConfig.DireTeam {
			if sid == req.SteamID2 {
				handler.gameConfig.DireTeam = append(handler.gameConfig.DireTeam[:i], handler.gameConfig.DireTeam[i+1:]...)
				break
			}
		}
		// Add to opposite teams
		handler.gameConfig.RadiantTeam = append(handler.gameConfig.RadiantTeam, req.SteamID2)
		handler.gameConfig.DireTeam = append(handler.gameConfig.DireTeam, req.SteamID1)
	} else {
		// Remove from current teams
		for i, sid := range handler.gameConfig.DireTeam {
			if sid == req.SteamID1 {
				handler.gameConfig.DireTeam = append(handler.gameConfig.DireTeam[:i], handler.gameConfig.DireTeam[i+1:]...)
				break
			}
		}
		for i, sid := range handler.gameConfig.RadiantTeam {
			if sid == req.SteamID2 {
				handler.gameConfig.RadiantTeam = append(handler.gameConfig.RadiantTeam[:i], handler.gameConfig.RadiantTeam[i+1:]...)
				break
			}
		}
		// Add to opposite teams
		handler.gameConfig.DireTeam = append(handler.gameConfig.DireTeam, req.SteamID2)
		handler.gameConfig.RadiantTeam = append(handler.gameConfig.RadiantTeam, req.SteamID1)
	}

	// Kick both players from teams so they re-seat correctly
	if handler.dota != nil {
		steamID1_32 := uint32(req.SteamID1 & 0xFFFFFFFF)
		steamID2_32 := uint32(req.SteamID2 & 0xFFFFFFFF)
		handler.dota.KickLobbyMemberFromTeam(steamID1_32)
		handler.dota.KickLobbyMemberFromTeam(steamID2_32)
	}

	log.Printf("[Game %s] Swapped players %d and %d", gameID, req.SteamID1, req.SteamID2)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "swapped"})
}

// ReplacePlayerRequest represents a request to replace a player
type ReplacePlayerRequest struct {
	OldSteamID uint64 `json:"old_steam_id"`
	NewSteamID uint64 `json:"new_steam_id"`
}

func handleReplacePlayer(w http.ResponseWriter, r *http.Request, handler *gcHandler, gameID string) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req ReplacePlayerRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, fmt.Sprintf("Invalid request: %v", err), http.StatusBadRequest)
		return
	}

	// Check if new player is already in game
	for _, sid := range handler.gameConfig.RadiantTeam {
		if sid == req.NewSteamID {
			http.Error(w, "New player is already in the game", http.StatusBadRequest)
			return
		}
	}
	for _, sid := range handler.gameConfig.DireTeam {
		if sid == req.NewSteamID {
			http.Error(w, "New player is already in the game", http.StatusBadRequest)
			return
		}
	}

	// Find and replace in Radiant
	replaced := false
	for i, sid := range handler.gameConfig.RadiantTeam {
		if sid == req.OldSteamID {
			handler.gameConfig.RadiantTeam[i] = req.NewSteamID
			replaced = true
			break
		}
	}

	// Find and replace in Dire if not found in Radiant
	if !replaced {
		for i, sid := range handler.gameConfig.DireTeam {
			if sid == req.OldSteamID {
				handler.gameConfig.DireTeam[i] = req.NewSteamID
				replaced = true
				break
			}
		}
	}

	if !replaced {
		http.Error(w, "Old player not found in game", http.StatusBadRequest)
		return
	}

	// Kick old player from team
	if handler.dota != nil {
		oldSteamID32 := uint32(req.OldSteamID & 0xFFFFFFFF)
		handler.dota.KickLobbyMemberFromTeam(oldSteamID32)
	}

	log.Printf("[Game %s] Replaced player %d with %d", gameID, req.OldSteamID, req.NewSteamID)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "replaced"})
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

	// Disconnect Steam client
	if handler.client != nil {
		handler.client.Disconnect()
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

// sendResultToMasterBot sends game result to the master bot via HTTP POST
func (h *gcHandler) sendResultToMasterBot(result *GameResult) error {
	resultJSON, err := json.Marshal(result)
	if err != nil {
		return fmt.Errorf("failed to marshal result: %v", err)
	}

	resp, err := http.Post(h.gameConfig.ResultURL, "application/json",
		bytes.NewBuffer(resultJSON))
	if err != nil {
		return fmt.Errorf("failed to POST result: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return fmt.Errorf("unexpected status code: %d", resp.StatusCode)
	}

	log.Printf("[Game %s] Successfully sent result to master bot", h.gameID)
	return nil
}

// teardownGame cleans up the game handler after completion
func (h *gcHandler) teardownGame() {
	log.Printf("[Game %s] Tearing down game handler", h.gameID)

	// Stop keepalive
	h.stopGCKeepalive()

	// Cancel context (this will also stop the keepalive goroutine)
	h.cancel()

	// Disconnect Steam client
	if h.client != nil {
		h.client.Disconnect()
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
	log.Printf("[Game %s] handleUpdateMultiple called: %d objects added, %d objects modified",
		h.gameID, len(updateMsg.GetObjectsAdded()), len(updateMsg.GetObjectsModified()))

	// Process added objects (lobby_new event equivalent) - send invites only here
	for _, obj := range updateMsg.GetObjectsAdded() {
		if obj.GetTypeId() == LobbyTypeID {
			log.Printf("[Game %s] Lobby object added (type %d) - equivalent to lobby_new event", h.gameID, obj.GetTypeId())
			h.parseCSODOTALobbyFromObjectData(obj.GetObjectData(), true) // true = isNewLobby
		}
	}
	// Process modified objects (lobby_changed event equivalent) - don't send invites
	for _, obj := range updateMsg.GetObjectsModified() {
		if obj.GetTypeId() == LobbyTypeID {
			log.Printf("[Game %s] Lobby object modified (type %d) - equivalent to lobby_changed event", h.gameID, obj.GetTypeId())
			h.parseCSODOTALobbyFromObjectData(obj.GetObjectData(), false) // false = not new lobby
		}
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

	log.Printf("[Game %s] Parsed lobby: ID=%d, PassKey=%s, GameName=%s, isNew=%v",
		h.gameID, lobbyID, passKeyFromLobby, gameName, isNewLobby)

	if lobbyID != 0 {
		log.Printf("[Game %s] Received lobby ID: %d", h.gameID, lobbyID)
		h.currentLobbyID = lobbyID

		// Only send invites when lobby is first created (isNewLobby = true), not on modifications
		if isNewLobby {
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
				// Send invites when lobby is first created (equivalent to lobby_new event in Python)
				// Wait a short time for GC to be fully ready
				go func() {
					time.Sleep(2 * time.Second)
					log.Printf("[Game %s] Sending invites after receiving new lobby ID", h.gameID)
					h.sendInvitesToPlayers()
				}()
			}
		}

		// State transition if we're still creating
		if h.getState() == "creating" {
			h.setState("waiting")
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

		// Auto-trigger polling when 7 players enter (6 players + bot = 7 total)
		// In debug mode, trigger when 2 players enter (1 player + bot = 2 total)
		autoPollSize := 7
		if h.gameConfig.DebugSteamID != 0 {
			autoPollSize = 2
		}

		if memberCount > autoPollSize && state == 0 { // UI state
			h.pollingMutex.Lock()
			if !h.pollingDone && !h.pollingActive && h.pollCallbackURL != "" {
				h.pollingActive = true
				h.pollingMutex.Unlock()

				// Notify Master_Bot to start polling
				go h.notifyPollingStarted()
				log.Printf("[Game %s] Lobby has %d players — triggering game mode poll", h.gameID, memberCount)
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
	allowSpectating := false
	allChat := true
	lan := false
	passKey := h.gameConfig.PassKey

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
				wrongTeamPlayers = append(wrongTeamPlayers, memberID)
			}
		} else if shouldBeDire {
			if team == DOTA_GC_TEAM_BAD_GUYS {
				direPlayers[memberID] = true
			} else {
				wrongTeamPlayers = append(wrongTeamPlayers, memberID)
			}
		} else if team == DOTA_GC_TEAM_GOOD_GUYS || team == DOTA_GC_TEAM_BAD_GUYS {
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
		// Launch when all expected players are seated (works for any team size)
		if expectedRadiantCount > 0 && expectedDireCount > 0 {
			log.Printf("[Game %s] All players assigned (%d Radiant, %d Dire) - launching", h.gameID, expectedRadiantCount, expectedDireCount)
			h.launchGame()
		}
	}
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

	// Check if polling is active - block launch if so
	h.pollingMutex.Lock()
	pollingActive := h.pollingActive
	h.pollingMutex.Unlock()

	if pollingActive {
		log.Printf("[Game %s] All players ready but polling is active — delaying launch", h.gameID)
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

	// Send invites directly - no need to add friends first
	// Players can be invited to lobbies without being friends
	for _, steamID64 := range allSteamIDs {
		if steamID64 == 0 {
			continue
		}

		steamID := steamid.SteamId(steamID64)

		// Send invite directly
		if h.dota != nil {
			h.dota.InviteLobbyMember(steamID)
			log.Printf("[Game %s] Sent invite to Steam ID %d", h.gameID, steamID64)
		} else {
			log.Printf("[Game %s] ERROR: Cannot send invite to Steam ID %d - dota client is nil", h.gameID, steamID64)
		}
	}

	log.Printf("[Game %s] Finished sending invites", h.gameID)
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
		pendingResult = &GameResult{
			GameID:       h.gameID,
			MatchID:      matchID,
			Duration:     match.GetDuration(),
			Outcome:      int32(match.GetMatchOutcome()),
			RadiantScore: match.GetRadiantTeamScore(),
			DireScore:    match.GetDireTeamScore(),
			StartTime:    match.GetStarttime(),
			LobbyType:    match.GetLobbyType(),
			GameMode:     uint32(match.GetGameMode()),
			Timestamp:    time.Now(),
		}
	} else {
		pendingResult.MatchID = matchID
		pendingResult.Duration = match.GetDuration()
		pendingResult.Outcome = int32(match.GetMatchOutcome())
		pendingResult.RadiantScore = match.GetRadiantTeamScore()
		pendingResult.DireScore = match.GetDireTeamScore()
		pendingResult.StartTime = match.GetStarttime()
		pendingResult.LobbyType = match.GetLobbyType()
		pendingResult.GameMode = uint32(match.GetGameMode())
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
	log.Printf("[Game %s] Processing complete game result: MatchID=%d, Outcome=%d",
		h.gameID, result.MatchID, result.Outcome)

	// Send result to master bot
	if err := h.sendResultToMasterBot(result); err != nil {
		log.Printf("[Game %s] Error sending result: %v", h.gameID, err)
		// Still teardown even if send fails
	}

	// Teardown the game handler
	h.teardownGame()
}

func createDotaLobby(ctx context.Context, handler *gcHandler, config *GameConfig) error {
	logger := logrus.New()
	client := steam.NewClient()
	client.Connect()

	handler.client = client

	var gcInitialized bool
	var lobbyCreated bool

	// Start event loop in background - it must keep running
	// The event loop must continue running to maintain the Steam connection
	go func() {
		for event := range client.Events() {
			select {
			case <-ctx.Done():
				log.Printf("[Game %s] Context cancelled, shutting down Steam client", config.GameID)
				client.Disconnect()
				return
			default:
			}

			switch e := event.(type) {
			case *steam.ConnectedEvent:
				log.Printf("[Game %s] Connected to Steam, logging in...", config.GameID)
				client.Auth.LogOn(&steam.LogOnDetails{
					Username: config.Username,
					Password: config.Password,
				})

			case *steam.LoggedOnEvent:
				log.Printf("[Game %s] Logged in to Steam", config.GameID)
				client.Social.SetPersonaState(steamlang.EPersonaState_Online)
				client.GC.SetGamesPlayed(570)

				// Initialize Dota client after login
				if !gcInitialized {
					gcInitialized = true
					go func() {
						time.Sleep(10 * time.Second) // Wait for GC bootstrap
						log.Printf("[Game %s] Initializing Dota 2 client...", config.GameID)
						dota := dota2.New(client, logger)
						handler.dota = dota
						client.GC.RegisterPacketHandler(handler)

						dota.SetPlaying(true)
						time.Sleep(1 * time.Second)
						dota.SayHello()
						time.Sleep(3 * time.Second)

						// Create lobby
						if !lobbyCreated {
							lobbyCreated = true
							log.Printf("[Game %s] Creating lobby...", config.GameID)
							gameName := config.GameName
							passKey := config.PassKey
							serverRegion := config.ServerRegion
							seriesType := uint32(46)

							cmPick := protocol.DOTA_CM_PICK_DOTA_CM_RANDOM.Enum()
							tvDelay := protocol.LobbyDotaTVDelay_LobbyDotaTV_10.Enum()
							visibility := protocol.DOTALobbyVisibility_DOTALobbyVisibility_Public.Enum()
							pausePolicy := protocol.LobbyDotaPauseSetting_LobbyDotaPauseSetting_Limited.Enum()
							selectionPriority := protocol.DOTASelectionPriorityRules_k_DOTASelectionPriorityRules_Manual.Enum()

							fillWithBots := false
							allowSpectating := true
							allChat := true
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
					handler.startGCKeepalive()
					go func() {
						time.Sleep(2 * time.Second)
						handler.recreateLobbyIfNeeded()
					}()
				}

			case error:
				log.Printf("[Game %s] Steam error: %v", config.GameID, e)

			case *steam.DisconnectedEvent:
				log.Printf("[Game %s] Disconnected from Steam", config.GameID)
				handler.setError("Disconnected from Steam")
				return
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
			time.Sleep(2 * time.Second)
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
	time.Sleep(1 * time.Second)
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

	cmPick := protocol.DOTA_CM_PICK_DOTA_CM_RANDOM.Enum()
	tvDelay := protocol.LobbyDotaTVDelay_LobbyDotaTV_10.Enum()
	visibility := protocol.DOTALobbyVisibility_DOTALobbyVisibility_Public.Enum()
	pausePolicy := protocol.LobbyDotaPauseSetting_LobbyDotaPauseSetting_Limited.Enum()
	selectionPriority := protocol.DOTASelectionPriorityRules_k_DOTASelectionPriorityRules_Manual.Enum()

	fillWithBots := false
	allowSpectating := false
	allChat := true
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
	})
}
