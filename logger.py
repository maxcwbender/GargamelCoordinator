import logging
import sys
from datetime import datetime

def setup_logging():

    #TODO: Capture Stdout/Stderr  or just use logging.info instead of prints
    timestamp = datetime.now().strftime('%Y-%m-%d_%H-%M-%S')
    logging.basicConfig(
        level=logging.INFO,  # Capture everything from DEBUG and up
        format='[%(asctime)s] [%(levelname)s] [%(name)s] %(message)s',
        handlers = [
            logging.FileHandler(f'logs/Gargamel_Log_{timestamp}.txt', encoding='utf-8'),
            logging.StreamHandler(sys.stdout)
        ]
    )

    # Log discord.py HTTP internals (rate-limit headers, 429 retries) to a separate file.
    # These are DEBUG-level messages that the root INFO logger would drop.
    discord_http_logger = logging.getLogger('discord.http')
    discord_http_logger.setLevel(logging.DEBUG)
    discord_http_handler = logging.FileHandler(
        f'logs/Discord_HTTP_{timestamp}.txt', encoding='utf-8'
    )
    discord_http_handler.setLevel(logging.DEBUG)
    discord_http_handler.setFormatter(
        logging.Formatter('[%(asctime)s] [%(levelname)s] [%(name)s] %(message)s')
    )
    discord_http_logger.addHandler(discord_http_handler)

    # Redirect unhandled exceptions (tracebacks) to logging
    def handle_exception(exc_type, exc_value, exc_traceback):
        if issubclass(exc_type, KeyboardInterrupt):
            # Let KeyboardInterrupt print as usual
            sys.__excepthook__(exc_type, exc_value, exc_traceback)
            return
        logging.getLogger("UncaughtException").error(
            "Uncaught exception",
            exc_info=(exc_type, exc_value, exc_traceback)
        )

    sys.excepthook = handle_exception

    # Redirect print() and other stdout/stderr to logging
    class StreamToLogger:
        def __init__(self, logger, level):
            self.logger = logger
            self.level = level
            self.linebuf = ''

        def write(self, buf):
            for line in buf.rstrip().splitlines():
                self.logger.log(self.level, line.rstrip())

        def flush(self):
            pass

    stdout_logger = logging.getLogger('STDOUT')
    stderr_logger = logging.getLogger('STDERR')

    sys.stdout = StreamToLogger(stdout_logger, logging.INFO)
    sys.stderr = StreamToLogger(stderr_logger, logging.ERROR)

