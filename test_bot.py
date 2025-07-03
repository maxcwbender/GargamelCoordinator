import pytest
import sqlite3
from unittest.mock import AsyncMock, MagicMock
from Master_Bot import Master_Bot

@pytest.fixture
def bot_with_db():
    bot = Master_Bot(config_path="tests/test_config.json")
    bot.con = sqlite3.connect(":memory:")

    with bot.con:
        bot.con.execute("CREATE TABLE users (discord_id INTEGER PRIMARY KEY, rating INTEGER, assignedRegistrant INTEGER, timesVouched INTEGER)")
        bot.con.execute("CREATE TABLE mod_notes (mod_id INTEGER, registrant_id INTEGER, notes TEXT, result INTEGER, resultMessage_id INTEGER)")
        bot.con.execute("INSERT INTO users (discord_id, rating, assignedRegistrant, timesVouched) VALUES (?, ?, ?, ?)", (1001, 3000, 2002, 0))
        bot.con.execute("INSERT INTO users (discord_id, rating, timesVouched) VALUES (?, ?, ?)", (2002, 2500, 0))

    bot.get_channel = MagicMock()
    bot.query_mod_results = MagicMock(return_value=(3, 1, 0))
    bot.the_guild = MagicMock()
    bot.coordinator = MagicMock()
    bot.coordinator.in_queue = MagicMock(return_value=False)
    bot.coordinator.add_player = MagicMock(return_value=10)
    bot.coordinator.remove_player = MagicMock()
    bot.update_queue_status_message = AsyncMock()
    bot.fetch_one = MagicMock()
    return bot

@pytest.fixture
def interaction():
    mock_interaction = MagicMock()
    mock_interaction.user.id = 1001
    mock_interaction.user.display_name = "ModUser"
    mock_interaction.user.name = "ModUser"
    mock_interaction.channel_id = 5555
    mock_interaction.id = 9999
    mock_interaction.response = AsyncMock()
    mock_interaction.response.is_done = AsyncMock(return_value=False)
    return mock_interaction

@pytest.mark.asyncio
async def test_queue_user_adds_player(bot_with_db, interaction):
    bot = bot_with_db
    interaction.response.is_done.return_value = False
    bot.fetch_one.return_value = 3500

    print("in_queue:", bot.coordinator.in_queue(interaction.user.id))
    print("fetch_one:", bot.fetch_one("SELECT rating FROM users WHERE discord_id = ?", (interaction.user.id,)))
    print("is_done:", interaction.response.is_done())

    result = await bot.queue_user(interaction)

    print("EXPECTED MESSAGE:", interaction.response.send_message.call_args)

    bot.coordinator.add_player.assert_called_once_with(interaction.user.id, 3500)
    bot.update_queue_status_message.assert_awaited()
    interaction.response.send_message.assert_awaited_with(
        "You're now queueing with rating 3500.", ephemeral=True
    )
    assert result is True

@pytest.mark.asyncio
async def test_queue_user_already_in_queue(bot_with_db, interaction):
    bot = bot_with_db
    bot.coordinator.in_queue.return_value = True

    result = await bot.queue_user(interaction)

    interaction.response.send_message.assert_awaited_with(
        "You're already in the queue, bozo.", ephemeral=True
    )
    assert result is False

@pytest.mark.asyncio
async def test_queue_user_no_rating(bot_with_db, interaction):
    bot = bot_with_db
    bot.coordinator.in_queue.return_value = False
    bot.fetch_one.return_value = None

    result = await bot.queue_user(interaction)

    interaction.response.send_message.assert_awaited_with(
        "You don't have a rating yet. Talk to an Administrator to get started.", ephemeral=True
    )
    assert result is False

@pytest.mark.asyncio
async def test_leave_queue_success(bot_with_db, interaction):
    bot = bot_with_db
    bot.coordinator.in_queue.return_value = True

    result = await bot.leave_queue(interaction)

    bot.coordinator.remove_player.assert_called_once_with(interaction.user.id)
    interaction.response.send_message.assert_awaited_with(
        "You have left the queue.", ephemeral=True
    )
    bot.update_queue_status_message.assert_awaited()
    assert result is not False

@pytest.mark.asyncio
async def test_leave_queue_not_in_queue(bot_with_db, interaction):
    bot = bot_with_db
    bot.coordinator.in_queue.return_value = False

    result = await bot.leave_queue(interaction)

    interaction.response.send_message.assert_awaited_with(
        "You're not in the queue, bozo, how are you gonna leave?", ephemeral=True
    )
    assert result is False

@pytest.mark.asyncio
async def test_mod_decision_success_approval_with_db(bot_with_db, interaction):
    bot = bot_with_db
    bot.config = {
        "MOD_CHANNEL_ID": 5555,
        "MOD_ASSIGNMENT": 3,
        "GENERAL_CHANNEL_ID": 999,
        "BENDER_ID": 123,
    }

    bot.fetch_one.return_value = 2002

    mock_member = AsyncMock()
    mock_member.id = 2002
    mock_member.display_name = "test_name"
    mock_member.add_roles = AsyncMock()
    mock_member.send = AsyncMock()

    bot.the_guild.fetch_member = AsyncMock(return_value=mock_member)
    bot.get_channel.return_value.send = AsyncMock()

    await bot._mod_decision(interaction, result=True, notes="Test Note", rating=3100)

    interaction.response.send_message.assert_awaited_with(
        "Thanks, moderation recorded.", ephemeral=True
    )

@pytest.mark.asyncio
async def test_mod_decision_no_registrant_with_db(bot_with_db, interaction):
    bot = bot_with_db
    bot.config = {
        "MOD_CHANNEL_ID": 5555,
        "MOD_ASSIGNMENT": 3,
        "GENERAL_CHANNEL_ID": 999,
        "BENDER_ID": 123,
    }

    bot.fetch_one.return_value = None

    with bot.con:
        bot.con.execute("UPDATE users SET assignedRegistrant = NULL WHERE discord_id = ?", (1001,))

    await bot._mod_decision(interaction, result=True, notes="No one assigned", rating=3000)

    interaction.response.send_message.assert_awaited_with(
        "<@1001>: no registrant assigned. Use /poll_registration.", ephemeral=True
    )

@pytest.mark.asyncio
async def test_clear_game_cleans_up(bot_with_db):
    bot = bot_with_db
    bot.config = {"GENERAL_V_CHANNEL_ID": 999}

    mock_channel = AsyncMock()
    mock_channel.members = []

    game_id = 1
    bot.game_map_inverse[game_id] = ({1, 2}, {3, 4})
    bot.game_map = {1: game_id, 2: game_id, 3: game_id, 4: game_id}
    bot.game_channels[game_id] = (mock_channel, mock_channel)

    bot.get_channel.return_value = mock_channel

    await bot.clear_game(game_id)

    assert game_id not in bot.game_map_inverse
    assert all(pid not in bot.game_map for pid in [1, 2, 3, 4])
    assert game_id not in bot.game_channels

    mock_channel.delete.assert_awaited()
    mock_channel.delete.assert_awaited()
