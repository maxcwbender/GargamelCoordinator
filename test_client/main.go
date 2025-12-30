package main

// This file is for testing the REST API
// Run with: go run test_client/main.go
// Make sure lobbymanager.go is running first on port 8080
//
// This file provides:
// - Automated test suite (run with: go run test_client/main.go)
// - Interactive manual testing mode (run with: go run test_client/main.go --interactive)
// Note: Make sure lobbymanager.go is running first on port 8080
//
// Interactive mode allows you to:
// - Create real lobbies with actual Steam credentials
// - Enter Steam IDs for teams interactively
// - Configure lobby settings (game mode, server region, cheats, etc.)
// - Update lobby settings in real-time
// - Monitor game status
// - Test full game lifecycle including teardown

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	baseURL = "http://localhost:8080"
)

// Test helper functions
func createGame(gameID, username, password, resultURL string, radiantTeam, direTeam []uint64) error {
	req := map[string]interface{}{
		"game_id":       gameID,
		"username":      username,
		"password":      password,
		"result_url":    resultURL,
		"radiant_team":  radiantTeam,
		"dire_team":     direTeam,
		"game_mode":     22, // Ranked All Pick
		"server_region": 2,  // US East
		"allow_cheats":  false,
		"game_name":     fmt.Sprintf("test_game_%s", gameID),
	}

	jsonData, err := json.Marshal(req)
	if err != nil {
		return fmt.Errorf("failed to marshal request: %v", err)
	}

	resp, err := http.Post(baseURL+"/game", "application/json", bytes.NewBuffer(jsonData))
	if err != nil {
		return fmt.Errorf("failed to create game: %v", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("unexpected status: %d, body: %s", resp.StatusCode, string(body))
	}

	log.Printf("✓ Created game %s: %s", gameID, string(body))
	return nil
}

func getGameStatus(gameID string) (map[string]interface{}, error) {
	resp, err := http.Get(baseURL + "/game/" + gameID)
	if err != nil {
		return nil, fmt.Errorf("failed to get game status: %v", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %v", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("unexpected status: %d, body: %s", resp.StatusCode, string(body))
	}

	var status map[string]interface{}
	if err := json.Unmarshal(body, &status); err != nil {
		return nil, fmt.Errorf("failed to unmarshal response: %v", err)
	}

	return status, nil
}

func updateLobbySettings(gameID string, gameMode *uint32, serverRegion *uint32, allowCheats *bool) error {
	req := make(map[string]interface{})
	if gameMode != nil {
		req["game_mode"] = *gameMode
	}
	if serverRegion != nil {
		req["server_region"] = *serverRegion
	}
	if allowCheats != nil {
		req["allow_cheats"] = *allowCheats
	}

	jsonData, err := json.Marshal(req)
	if err != nil {
		return fmt.Errorf("failed to marshal request: %v", err)
	}

	httpReq, err := http.NewRequest("PUT", baseURL+"/game/"+gameID, bytes.NewBuffer(jsonData))
	if err != nil {
		return fmt.Errorf("failed to create request: %v", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")

	client := &http.Client{}
	resp, err := client.Do(httpReq)
	if err != nil {
		return fmt.Errorf("failed to update settings: %v", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("unexpected status: %d, body: %s", resp.StatusCode, string(body))
	}

	log.Printf("✓ Updated lobby settings for game %s: %s", gameID, string(body))
	return nil
}

func listGames() ([]map[string]interface{}, error) {
	resp, err := http.Get(baseURL + "/games")
	if err != nil {
		return nil, fmt.Errorf("failed to list games: %v", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %v", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("unexpected status: %d, body: %s", resp.StatusCode, string(body))
	}

	var games []map[string]interface{}
	if err := json.Unmarshal(body, &games); err != nil {
		return nil, fmt.Errorf("failed to unmarshal response: %v", err)
	}

	return games, nil
}

func deleteGame(gameID string) error {
	httpReq, err := http.NewRequest("DELETE", baseURL+"/game/"+gameID, nil)
	if err != nil {
		return fmt.Errorf("failed to create request: %v", err)
	}

	client := &http.Client{}
	resp, err := client.Do(httpReq)
	if err != nil {
		return fmt.Errorf("failed to delete game: %v", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("unexpected status: %d, body: %s", resp.StatusCode, string(body))
	}

	log.Printf("✓ Deleted game %s: %s", gameID, string(body))
	return nil
}

func printGameStatus(status map[string]interface{}) {
	fmt.Println("\n=== Game Status ===")
	if gameID, ok := status["game_id"].(string); ok {
		fmt.Printf("Game ID: %s\n", gameID)
	}
	if state, ok := status["state"].(string); ok {
		fmt.Printf("State: %s\n", state)
	}
	if lobbyID, ok := status["lobby_id"].(float64); ok {
		fmt.Printf("Lobby ID: %.0f\n", lobbyID)
	}
	if gameMode, ok := status["game_mode"].(float64); ok {
		fmt.Printf("Game Mode: %.0f\n", gameMode)
	}
	if serverRegion, ok := status["server_region"].(float64); ok {
		fmt.Printf("Server Region: %.0f\n", serverRegion)
	}
	if allowCheats, ok := status["allow_cheats"].(bool); ok {
		fmt.Printf("Allow Cheats: %v\n", allowCheats)
	}
	if radiantCount, ok := status["radiant_count"].(float64); ok {
		fmt.Printf("Radiant Count: %.0f\n", radiantCount)
	}
	if direCount, ok := status["dire_count"].(float64); ok {
		fmt.Printf("Dire Count: %.0f\n", direCount)
	}
	if err, ok := status["error"].(string); ok && err != "" {
		fmt.Printf("Error: %s\n", err)
	}
	fmt.Println("==================\n")
}

func readString(prompt string) string {
	fmt.Print(prompt)
	reader := bufio.NewReader(os.Stdin)
	input, _ := reader.ReadString('\n')
	return strings.TrimSpace(input)
}

func readStringWithDefault(prompt string, defaultValue string) string {
	if defaultValue != "" {
		fmt.Printf("%s (default: %s): ", prompt, defaultValue)
	} else {
		fmt.Print(prompt)
	}
	reader := bufio.NewReader(os.Stdin)
	input, _ := reader.ReadString('\n')
	input = strings.TrimSpace(input)
	if input == "" {
		return defaultValue
	}
	return input
}

type Config struct {
	Username0 string `json:"username_0"`
	Password0 string `json:"password_0"`
}

func loadConfig() (*Config, error) {
	// Try to find config.json in parent directory
	configPath := filepath.Join("..", "config.json")
	if _, err := os.Stat(configPath); os.IsNotExist(err) {
		// Try current directory
		configPath = "config.json"
		if _, err := os.Stat(configPath); os.IsNotExist(err) {
			return nil, fmt.Errorf("config.json not found")
		}
	}

	data, err := os.ReadFile(configPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read config.json: %v", err)
	}

	var config Config
	if err := json.Unmarshal(data, &config); err != nil {
		return nil, fmt.Errorf("failed to parse config.json: %v", err)
	}

	return &config, nil
}

func readUint64(prompt string) uint64 {
	for {
		input := readString(prompt)
		val, err := strconv.ParseUint(input, 10, 64)
		if err == nil {
			return val
		}
		fmt.Printf("Invalid number, please try again.\n")
	}
}

func readUint32(prompt string) uint32 {
	for {
		input := readString(prompt)
		val, err := strconv.ParseUint(input, 10, 32)
		if err == nil {
			return uint32(val)
		}
		fmt.Printf("Invalid number, please try again.\n")
	}
}

func readBool(prompt string) bool {
	for {
		input := strings.ToLower(readString(prompt))
		if input == "y" || input == "yes" || input == "true" || input == "1" {
			return true
		}
		if input == "n" || input == "no" || input == "false" || input == "0" {
			return false
		}
		fmt.Printf("Please enter 'y' or 'n'.\n")
	}
}

func readSteamIDList(prompt string) []uint64 {
	fmt.Println(prompt)
	var steamIDs []uint64
	reader := bufio.NewReader(os.Stdin)
	for {
		line, _ := reader.ReadString('\n')
		line = strings.TrimSpace(line)
		if line == "" {
			break
		}
		steamID, err := strconv.ParseUint(line, 10, 64)
		if err != nil {
			fmt.Printf("Invalid Steam ID: %s, skipping...\n", line)
			continue
		}
		steamIDs = append(steamIDs, steamID)
		fmt.Printf("  Added Steam ID: %d\n", steamID)
	}
	return steamIDs
}

func readSteamIDListWithDefault(prompt string, defaultSteamID uint64) []uint64 {
	fmt.Println(prompt)
	var steamIDs []uint64
	reader := bufio.NewReader(os.Stdin)

	// Read first line
	firstLine, _ := reader.ReadString('\n')
	firstLine = strings.TrimSpace(firstLine)

	// If first line is empty, use default
	if firstLine == "" {
		steamIDs = append(steamIDs, defaultSteamID)
		fmt.Printf("  Using default Steam ID: %d\n", defaultSteamID)
		return steamIDs
	}

	// Parse first line
	steamID, err := strconv.ParseUint(firstLine, 10, 64)
	if err != nil {
		fmt.Printf("Invalid Steam ID: %s, using default: %d\n", firstLine, defaultSteamID)
		steamIDs = append(steamIDs, defaultSteamID)
		return steamIDs
	}
	steamIDs = append(steamIDs, steamID)
	fmt.Printf("  Added Steam ID: %d\n", steamID)

	// Continue reading more IDs
	for {
		line, _ := reader.ReadString('\n')
		line = strings.TrimSpace(line)
		if line == "" {
			break
		}
		steamID, err := strconv.ParseUint(line, 10, 64)
		if err != nil {
			fmt.Printf("Invalid Steam ID: %s, skipping...\n", line)
			continue
		}
		steamIDs = append(steamIDs, steamID)
		fmt.Printf("  Added Steam ID: %d\n", steamID)
	}
	return steamIDs
}

func interactiveMode() {
	scanner := bufio.NewScanner(os.Stdin)
	var currentGameID string

	// Load config for defaults
	config, err := loadConfig()
	if err != nil {
		log.Printf("Warning: Could not load config.json: %v. Defaults will not be available.", err)
		config = &Config{} // Use empty config
	}

	fmt.Println("\n" + strings.Repeat("=", 60))
	fmt.Println("  Gargamel Coordinator - Interactive Test Mode")
	fmt.Println(strings.Repeat("=", 60))
	fmt.Println()

	for {
		fmt.Println("\n=== Main Menu ===")
		fmt.Println("1. Create new game")
		fmt.Println("2. View game status")
		fmt.Println("3. Update lobby settings")
		fmt.Println("4. List all games")
		fmt.Println("5. Monitor game status (polling)")
		fmt.Println("6. Delete game")
		fmt.Println("7. Exit")
		fmt.Print("\nSelect option: ")

		scanner.Scan()
		choice := strings.TrimSpace(scanner.Text())

		switch choice {
		case "1":
			fmt.Println("\n--- Create New Game ---")

			// Set defaults
			defaultGameID := "87"
			defaultUsername := config.Username0
			defaultPassword := config.Password0
			defaultResultURL := "http://localhost:9999/results/"
			defaultGameMode := uint32(22)    // Ranked All Pick
			defaultServerRegion := uint32(2) // US East
			defaultGameName := "Gargamel League Game Test"
			defaultPassKey := "1234"
			defaultDebugSteamID := uint64(76561197963274329)
			defaultRadiantSteamID := uint64(76561197963274329)

			gameID := readStringWithDefault("Game ID", defaultGameID)
			username := readStringWithDefault("Steam Username", defaultUsername)
			password := readStringWithDefault("Steam Password", defaultPassword)
			resultURL := readStringWithDefault("Result Callback URL", defaultResultURL)

			fmt.Println("\nGame Mode Options:")
			fmt.Println("  0 = None")
			fmt.Println("  2 = Captain's Mode")
			fmt.Println("  3 = Random Draft")
			fmt.Println("  4 = Single Draft")
			fmt.Println("  5 = All Random")
			fmt.Println("  8 = Reverse Captain's Mode")
			fmt.Println("  11 = Mid Only")
			fmt.Println("  12 = Least Played")
			fmt.Println("  16 = Captain's Draft")
			fmt.Println("  18 = Ability Draft")
			fmt.Println("  20 = All Random Death Match")
			fmt.Println("  22 = Ranked All Pick")
			fmt.Println("  23 = Turbo")
			gameModeInput := readStringWithDefault("Game Mode", "22")
			gameMode, err := strconv.ParseUint(gameModeInput, 10, 32)
			if err != nil || gameMode == 0 {
				gameMode = uint64(defaultGameMode)
			}

			fmt.Println("\nServer Region Options:")
			fmt.Println("  1 = US West")
			fmt.Println("  2 = US East")
			fmt.Println("  3 = Europe West")
			fmt.Println("  4 = Europe East")
			fmt.Println("  5 = China")
			fmt.Println("  6 = Southeast Asia")
			serverRegionInput := readStringWithDefault("Server Region", "2")
			serverRegion, err := strconv.ParseUint(serverRegionInput, 10, 32)
			if err != nil || serverRegion == 0 {
				serverRegion = uint64(defaultServerRegion)
			}

			allowCheats := readBool("Allow Cheats? (y/n, default n): ")
			gameName := readStringWithDefault("Game Name", defaultGameName)
			passKey := readStringWithDefault("Lobby Password", defaultPassKey)

			debugSteamIDInput := readStringWithDefault("Debug Steam ID", fmt.Sprintf("%d", defaultDebugSteamID))
			debugSteamID, err := strconv.ParseUint(debugSteamIDInput, 10, 64)
			if err != nil {
				debugSteamID = defaultDebugSteamID
			}

			fmt.Println("\n--- Radiant Team ---")
			fmt.Printf("Enter Radiant team Steam IDs (default: %d, press Enter to use default, or enter IDs one per line):\n", defaultRadiantSteamID)
			radiantTeam := readSteamIDListWithDefault("Enter Steam IDs (one per line, empty line to finish)", defaultRadiantSteamID)

			fmt.Println("\n--- Dire Team ---")
			fmt.Println("Enter Dire team Steam IDs (press Enter for empty, or enter IDs one per line):")
			direTeam := readSteamIDList("Enter Steam IDs (one per line, empty line to finish):")

			// Create game
			req := map[string]interface{}{
				"game_id":        gameID,
				"username":       username,
				"password":       password,
				"result_url":     resultURL,
				"radiant_team":   radiantTeam,
				"dire_team":      direTeam,
				"game_mode":      uint32(gameMode),
				"server_region":  uint32(serverRegion),
				"allow_cheats":   allowCheats,
				"game_name":      gameName,
				"pass_key":       passKey,
				"debug_steam_id": debugSteamID,
			}

			jsonData, err := json.Marshal(req)
			if err != nil {
				fmt.Printf("Error: Failed to marshal request: %v\n", err)
				continue
			}

			resp, err := http.Post(baseURL+"/game", "application/json", bytes.NewBuffer(jsonData))
			if err != nil {
				fmt.Printf("Error: Failed to create game: %v\n", err)
				continue
			}
			defer resp.Body.Close()

			body, _ := io.ReadAll(resp.Body)
			if resp.StatusCode != http.StatusOK {
				fmt.Printf("Error: Unexpected status %d: %s\n", resp.StatusCode, string(body))
				continue
			}

			fmt.Printf("\n✓ Game created successfully!\n")
			fmt.Printf("Response: %s\n", string(body))
			currentGameID = gameID

		case "2":
			if currentGameID == "" {
				currentGameID = readString("Game ID: ")
			}
			fmt.Printf("\n--- Game Status for %s ---\n", currentGameID)
			status, err := getGameStatus(currentGameID)
			if err != nil {
				fmt.Printf("Error: %v\n", err)
			} else {
				printGameStatus(status)
			}

		case "3":
			if currentGameID == "" {
				currentGameID = readString("Game ID: ")
			}

			fmt.Println("\n--- Update Lobby Settings ---")
			fmt.Println("Leave blank to keep current value")

			var gameMode *uint32
			var serverRegion *uint32
			var allowCheats *bool
			var gameName string

			fmt.Println("\nGame Mode Options:")
			fmt.Println("  0 = None, 2 = CM, 3 = RD, 4 = SD, 5 = AR")
			fmt.Println("  8 = Reverse CM, 11 = Mid Only, 12 = Least Played")
			fmt.Println("  16 = CD, 18 = Ability Draft, 20 = ARDM")
			fmt.Println("  22 = Ranked All Pick, 23 = Turbo")
			modeInput := readString("New Game Mode (blank to skip): ")
			if modeInput != "" {
				if val, err := strconv.ParseUint(modeInput, 10, 32); err == nil {
					gm := uint32(val)
					gameMode = &gm
				}
			}

			regionInput := readString("New Server Region (blank to skip): ")
			if regionInput != "" {
				if val, err := strconv.ParseUint(regionInput, 10, 32); err == nil {
					sr := uint32(val)
					serverRegion = &sr
				}
			}

			cheatsInput := readString("Allow Cheats? (y/n/blank to skip): ")
			if cheatsInput != "" {
				ac := strings.ToLower(cheatsInput) == "y" || strings.ToLower(cheatsInput) == "yes" || strings.ToLower(cheatsInput) == "true" || cheatsInput == "1"
				allowCheats = &ac
			}

			gameName = readString("New Game Name (blank to skip): ")

			err := updateLobbySettings(currentGameID, gameMode, serverRegion, allowCheats)
			if err != nil {
				fmt.Printf("Error: %v\n", err)
			} else {
				fmt.Println("\n✓ Settings updated successfully!")
				if gameName != "" {
					// Update game name separately if provided
					req := map[string]interface{}{"game_name": gameName}
					jsonData, _ := json.Marshal(req)
					httpReq, _ := http.NewRequest("PUT", baseURL+"/game/"+currentGameID, bytes.NewBuffer(jsonData))
					httpReq.Header.Set("Content-Type", "application/json")
					client := &http.Client{}
					client.Do(httpReq)
				}
			}

		case "4":
			fmt.Println("\n--- All Games ---")
			games, err := listGames()
			if err != nil {
				fmt.Printf("Error: %v\n", err)
			} else {
				fmt.Printf("\n=== All Games (%d) ===\n", len(games))
				for i, game := range games {
					if gameID, ok := game["game_id"].(string); ok {
						if state, ok := game["state"].(string); ok {
							lobbyID := ""
							if lid, ok := game["lobby_id"].(float64); ok && lid > 0 {
								lobbyID = fmt.Sprintf(" (Lobby: %.0f)", lid)
							}
							fmt.Printf("%d. Game ID: %s, State: %s%s\n", i+1, gameID, state, lobbyID)
						}
					}
				}
				fmt.Println("====================")
			}

		case "5":
			if currentGameID == "" {
				currentGameID = readString("Game ID: ")
			}
			pollCount := readUint32("Number of polls (default 5): ")
			if pollCount == 0 {
				pollCount = 5
			}
			interval := readUint32("Interval in seconds (default 2): ")
			if interval == 0 {
				interval = 2
			}

			fmt.Printf("\n--- Monitoring Game %s ---\n", currentGameID)
			for i := uint32(0); i < pollCount; i++ {
				status, err := getGameStatus(currentGameID)
				if err != nil {
					fmt.Printf("Poll %d/%d: Error - %v\n", i+1, pollCount, err)
				} else {
					if state, ok := status["state"].(string); ok {
						fmt.Printf("Poll %d/%d: State = %s", i+1, pollCount, state)
						if lobbyID, ok := status["lobby_id"].(float64); ok && lobbyID > 0 {
							fmt.Printf(", Lobby ID = %.0f", lobbyID)
						}
						if radiantCount, ok := status["radiant_count"].(float64); ok {
							fmt.Printf(", Radiant = %.0f", radiantCount)
						}
						if direCount, ok := status["dire_count"].(float64); ok {
							fmt.Printf(", Dire = %.0f", direCount)
						}
						fmt.Println()
					}
				}
				if i < pollCount-1 {
					time.Sleep(time.Duration(interval) * time.Second)
				}
			}

		case "6":
			if currentGameID == "" {
				currentGameID = readString("Game ID to delete: ")
			}
			confirm := readString(fmt.Sprintf("Are you sure you want to delete game %s? (yes/no): ", currentGameID))
			if strings.ToLower(confirm) == "yes" {
				err := deleteGame(currentGameID)
				if err != nil {
					fmt.Printf("Error: %v\n", err)
				} else {
					fmt.Printf("\n✓ Game %s deleted successfully!\n", currentGameID)
					if currentGameID != "" {
						currentGameID = ""
					}
				}
			} else {
				fmt.Println("Deletion cancelled.")
			}

		case "7":
			fmt.Println("\nExiting interactive mode. Goodbye!")
			return

		default:
			fmt.Println("Invalid option. Please try again.")
		}
	}
}

func automatedTests() {
	log.Println("Starting REST API test client...")
	log.Printf("Testing against: %s\n", baseURL)

	// Test 1: Create a game
	gameID1 := "test_game_001"
	log.Println("\n[Test 1] Creating game...")
	err := createGame(
		gameID1,
		"test_username_1",
		"test_password_1",
		"http://localhost:9999/results", // Mock result URL
		[]uint64{76561197963274329},     // Radiant team (single player for testing)
		[]uint64{},                      // Dire team (empty for testing)
	)
	if err != nil {
		log.Fatalf("Failed to create game: %v", err)
	}

	// Wait a bit for game to initialize
	time.Sleep(2 * time.Second)

	// Test 2: Get game status
	log.Println("\n[Test 2] Getting game status...")
	status, err := getGameStatus(gameID1)
	if err != nil {
		log.Fatalf("Failed to get game status: %v", err)
	}
	printGameStatus(status)

	// Test 3: Update lobby settings
	log.Println("\n[Test 3] Updating lobby settings...")
	newGameMode := uint32(23) // Turbo mode
	err = updateLobbySettings(gameID1, &newGameMode, nil, nil)
	if err != nil {
		log.Fatalf("Failed to update settings: %v", err)
	}

	// Wait a bit for update to process
	time.Sleep(1 * time.Second)

	// Verify the update
	status, err = getGameStatus(gameID1)
	if err != nil {
		log.Fatalf("Failed to get updated status: %v", err)
	}
	printGameStatus(status)

	// Test 4: Create a second game (test concurrent games)
	gameID2 := "test_game_002"
	log.Println("\n[Test 4] Creating second game (concurrent)...")
	err = createGame(
		gameID2,
		"test_username_2",
		"test_password_2",
		"http://localhost:9999/results",
		[]uint64{76561197963274329},
		[]uint64{},
	)
	if err != nil {
		log.Fatalf("Failed to create second game: %v", err)
	}

	time.Sleep(2 * time.Second)

	// Test 5: List all games
	log.Println("\n[Test 5] Listing all games...")
	games, err := listGames()
	if err != nil {
		log.Fatalf("Failed to list games: %v", err)
	}
	fmt.Printf("\n=== All Games (%d) ===\n", len(games))
	for i, game := range games {
		if gameID, ok := game["game_id"].(string); ok {
			if state, ok := game["state"].(string); ok {
				fmt.Printf("%d. Game ID: %s, State: %s\n", i+1, gameID, state)
			}
		}
	}
	fmt.Println("====================\n")

	// Test 6: Update settings on second game
	log.Println("\n[Test 6] Updating settings on second game...")
	allowCheats := true
	err = updateLobbySettings(gameID2, nil, nil, &allowCheats)
	if err != nil {
		log.Fatalf("Failed to update second game: %v", err)
	}

	// Test 7: Monitor game status (poll a few times)
	log.Println("\n[Test 7] Monitoring game status (polling 3 times)...")
	for i := 0; i < 3; i++ {
		status, err = getGameStatus(gameID1)
		if err != nil {
			log.Printf("Error getting status: %v", err)
		} else {
			if state, ok := status["state"].(string); ok {
				fmt.Printf("Poll %d: Game %s state = %s\n", i+1, gameID1, state)
			}
		}
		time.Sleep(2 * time.Second)
	}

	// Test 8: Delete games
	log.Println("\n[Test 8] Cleaning up - deleting games...")
	err = deleteGame(gameID1)
	if err != nil {
		log.Printf("Failed to delete game 1: %v", err)
	}

	err = deleteGame(gameID2)
	if err != nil {
		log.Printf("Failed to delete game 2: %v", err)
	}

	// Verify games are deleted
	log.Println("\n[Test 9] Verifying games are deleted...")
	games, err = listGames()
	if err != nil {
		log.Printf("Failed to list games: %v", err)
	} else {
		fmt.Printf("Remaining games: %d\n", len(games))
	}

	log.Println("\n✓ All tests completed!")
}

func main() {
	// Check for interactive flag
	if len(os.Args) > 1 && (os.Args[1] == "--interactive" || os.Args[1] == "-i") {
		interactiveMode()
	} else {
		automatedTests()
	}
}
