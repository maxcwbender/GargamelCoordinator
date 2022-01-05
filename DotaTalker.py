from steam.client import SteamClient
from dota2.client import Dota2Client
import json


with open("config.json") as configFile:
    config: dict = json.load(configFile)

steamClient = SteamClient()
dotaClient = Dota2Client(steamClient)

@steamClient.on('logged_on')
def start_dota():
    dotaClient.launch()

@dotaClient.on('ready')
def do_dota_stuff():
    # talk to GC
    print('Launched DotA')

    
result = steamClient.login(username = config.get('username'), 
                  password = config.get('password'))
steamClient.run_forever()
print(result)