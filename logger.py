import logging
from datetime import datetime

def setup_logging():

    #TODO: Capture Stdout/Stderr  or just use logging.info instead of prints
    timestamp = datetime.now().strftime('%Y-%m-%d_%H-%M-%S')
    logging.getLogger('discord.http').setLevel(logging.DEBUG)
    logging.basicConfig(
        filename=f'logs/Gargamel_Log_{timestamp}.txt',  # Log file name
        filemode='a',  # 'w' = overwrite on each run, use 'a' to append
        level=logging.DEBUG,  # Capture everything from DEBUG and up
        format='[%(asctime)s] [%(levelname)s] [%(name)s] %(message)s'
    )

