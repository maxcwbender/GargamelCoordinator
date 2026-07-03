# Dev-only mock of the passport/auth API (mirrors the Express contract in
# index.mjs + auth.mjs) for previewing public/index.html and public/player.html
# without Node.
# Run: py .claude/mock-passport-server.py  -> http://localhost:3299/
#
# Switch the simulated login state at runtime:
#   GET /mock/mode/anon          - not logged in
#   GET /mock/mode/unregistered  - logged in, not registered
#   GET /mock/mode/registered    - logged in + registered (default)
import json
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

PUBLIC = Path(__file__).resolve().parent.parent / 'public'

MODE = ['registered']  # anon | unregistered | registered
ME_ID = '111111111111111111'
CSRF = 'mock-csrf-token'

HEROES = [
    {'id': 1, 'name': 'Anti-Mage', 'img': 'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/antimage.png'},
    {'id': 8, 'name': 'Juggernaut', 'img': 'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/juggernaut.png'},
    {'id': 14, 'name': 'Pudge', 'img': 'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/pudge.png'},
    {'id': 26, 'name': 'Lion', 'img': 'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/lion.png'},
    {'id': 74, 'name': 'Invoker', 'img': 'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/invoker.png'},
    {'id': 86, 'name': 'Rubick', 'img': 'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/rubick.png'},
]
HERO_BY_ID = {h['id']: h for h in HEROES}

# Mutable profile state so edit round-trips are observable in the preview
profile = {'rolePrefs': [2, 4], 'favoriteHeroes': [14, 74], 'linked': False, 'linkMethod': None}

PLAYERS = {
    ME_ID: {'discordName': 'TestPlayer', 'rating': 3300, 'hasMatches': True},
    '222222222222222222': {'discordName': 'OtherPlayer', 'rating': 4100, 'hasMatches': True},
    '333333333333333333': {'discordName': 'NeverPlayed', 'rating': 3000, 'hasMatches': False},
}


def passport_payload(discord_id):
    p = PLAYERS[discord_id]
    own = discord_id == ME_ID
    matches = []
    if p['hasMatches']:
        for i, mid in enumerate([8745399999, 8745398888, 8745397777, 8745386473, 8745380000]):
            matches.append({'matchId': mid, 'team': i % 2,
                            'opendotaUrl': f'https://www.opendota.com/matches/{mid}'})
    favs = profile['favoriteHeroes'] if own else [8, 26]
    prefs = profile['rolePrefs'] if own else [1]
    return {
        'discordId': discord_id,
        'discordName': p['discordName'],
        'discordAvatar': 'https://cdn.discordapp.com/embed/avatars/2.png',
        'steam': {
            'accountId': 39734272,
            'personaname': p['discordName'] + 'OnSteam',
            'avatar': 'https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_full.jpg',
            'linked': profile['linked'] if own else True,
            'linkMethod': profile['linkMethod'] if own else 'steam_openid',
        },
        'rolePrefs': prefs,
        'favoriteHeroes': [
            {'id': h, 'name': HERO_BY_ID.get(h, {}).get('name', f'Hero {h}'),
             'img': HERO_BY_ID.get(h, {}).get('img')}
            for h in favs
        ],
        'recentMatches': matches,
        'rating': p['rating'],
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print('[mock]', fmt % args)

    def send_json(self, status, obj):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, name, ctype='text/html'):
        path = PUBLIC / name
        if not path.is_file():
            return self.send_json(404, {'error': 'missing file ' + name})
        body = path.read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_body(self):
        length = int(self.headers.get('Content-Length') or 0)
        try:
            return json.loads(self.rfile.read(length) or b'{}')
        except json.JSONDecodeError:
            return {}

    def csrf_ok(self):
        return self.headers.get('X-CSRF-Token') == CSRF

    def do_GET(self):
        path = urlparse(self.path).path

        m = re.match(r'^/mock/mode/(anon|unregistered|registered)$', path)
        if m:
            MODE[0] = m.group(1)
            return self.send_json(200, {'mode': MODE[0]})

        if path == '/api/me':
            if MODE[0] == 'anon':
                return self.send_json(401, {'error': 'Not logged in'})
            return self.send_json(200, {
                'discordId': ME_ID,
                'username': 'TestPlayer',
                'avatarUrl': 'https://cdn.discordapp.com/embed/avatars/2.png',
                'registered': MODE[0] == 'registered',
                'csrfToken': CSRF,
            })

        if path == '/api/heroes':
            return self.send_json(200, HEROES)

        if path == '/api/discord-members':
            return self.send_json(200, [
                {'name': 'TestPlayer', 'avatar': 'https://cdn.discordapp.com/embed/avatars/2.png'},
                {'name': 'OtherPlayer', 'avatar': 'https://cdn.discordapp.com/embed/avatars/3.png'},
            ])

        m = re.match(r'^/api/players/(\d+)$', path)
        if m:
            if m.group(1) not in PLAYERS:
                return self.send_json(404, {'error': 'Player not found'})
            return self.send_json(200, passport_payload(m.group(1)))

        if path == '/players/me':
            if MODE[0] == 'anon':
                self.send_response(302)
                self.send_header('Location', '/auth/discord/login?next=%2Fplayers%2Fme')
                self.end_headers()
                return
            self.send_response(302)
            self.send_header('Location', f'/players/{ME_ID}')
            self.end_headers()
            return

        if re.match(r'^/players/\d+$', path):
            return self.send_file('player.html')

        if path.startswith('/auth/discord/login'):
            # Simulate the OAuth round-trip: "log in" and bounce home
            MODE[0] = 'registered' if MODE[0] != 'unregistered' else 'unregistered'
            self.send_response(302)
            self.send_header('Location', '/')
            self.end_headers()
            return

        if path.startswith('/auth/steam/login'):
            profile['linked'] = True
            profile['linkMethod'] = 'steam_openid'
            self.send_response(302)
            self.send_header('Location', f'/players/{ME_ID}?steam=linked')
            self.end_headers()
            return

        if path == '/':
            return self.send_file('index.html')

        # Static assets from public/
        name = path.lstrip('/')
        if name and (PUBLIC / name).is_file():
            ctype = 'application/javascript' if name.endswith('.js') else \
                    'image/png' if name.endswith('.png') else 'text/html'
            return self.send_file(name, ctype)

        return self.send_json(404, {'error': 'not found'})

    def do_POST(self):
        path = urlparse(self.path).path
        if path == '/api/register':
            if MODE[0] == 'anon':
                return self.send_json(401, {'error': 'Not logged in'})
            if not self.csrf_ok():
                return self.send_json(403, {'error': 'Invalid CSRF token'})
            body = self.read_body()
            if not body.get('rank'):
                return self.send_json(400, {'result': 'Please select your Dota 2 rank'})
            MODE[0] = 'registered'
            return self.send_json(201, {'result': 'TestPlayerOnSteam'})

        if path == '/api/steam/confirm':
            if not self.csrf_ok():
                return self.send_json(403, {'error': 'Invalid CSRF token'})
            profile['linked'] = True
            profile['linkMethod'] = 'discord_connection'
            return self.send_json(200, {'result': 'Steam account confirmed'})

        if path == '/api/steam/unlink':
            if not self.csrf_ok():
                return self.send_json(403, {'error': 'Invalid CSRF token'})
            profile['linked'] = False
            profile['linkMethod'] = None
            return self.send_json(200, {'result': 'Steam link removed'})

        if path == '/auth/logout':
            if not self.csrf_ok():
                return self.send_json(403, {'error': 'Invalid CSRF token'})
            MODE[0] = 'anon'
            return self.send_json(200, {'result': 'Logged out'})

        return self.send_json(404, {'error': 'not found'})

    def do_PUT(self):
        path = urlparse(self.path).path
        if path == '/api/players/me/profile':
            if MODE[0] == 'anon':
                return self.send_json(401, {'error': 'Not logged in'})
            if not self.csrf_ok():
                return self.send_json(403, {'error': 'Invalid CSRF token'})
            body = self.read_body()
            roles = body.get('rolePrefs')
            heroes = body.get('favoriteHeroes')
            if not isinstance(roles, list) or not isinstance(heroes, list):
                return self.send_json(400, {'error': 'rolePrefs and favoriteHeroes must be arrays'})
            if any((not isinstance(r, int)) or r < 1 or r > 5 for r in roles):
                return self.send_json(400, {'error': 'Role preferences must be positions 1 through 5'})
            if len(heroes) > 3:
                return self.send_json(400, {'error': 'Favorite heroes must be up to 3 hero ids'})
            profile['rolePrefs'] = sorted(set(roles))
            profile['favoriteHeroes'] = list(dict.fromkeys(heroes))
            return self.send_json(200, {'result': 'Profile updated'})

        if path == '/':
            return self.send_json(410, {'result': 'Registration has moved. Please reload the page and sign in with Discord.'})

        return self.send_json(404, {'error': 'not found'})


if __name__ == '__main__':
    print('Mock passport server: http://localhost:3299/')
    print(f'Own passport:        http://localhost:3299/players/{ME_ID}')
    print('Other passport:      http://localhost:3299/players/222222222222222222')
    print('No-matches player:   http://localhost:3299/players/333333333333333333')
    print('Mode switch:         /mock/mode/anon|unregistered|registered')
    ThreadingHTTPServer(('127.0.0.1', 3299), Handler).serve_forever()
