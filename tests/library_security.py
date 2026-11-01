"""Attack tests for the public library database (supabase/schema.sql).
Each test tries to store something that isn't a proper guide, or to abuse the library,
and expects the database itself to refuse it. Called from e2e.py with a running LocalLibrary."""
import base64, hashlib, io, json, urllib.error, urllib.request
from PIL import Image


def jpeg(color=(200, 30, 30), size=(64, 48), quality=80):
    buf = io.BytesIO()
    Image.new('RGB', size, color).save(buf, 'JPEG', quality=quality)
    return buf.getvalue()


def png(color=(30, 200, 30)):
    buf = io.BytesIO()
    Image.new('RGB', (40, 40), color).save(buf, 'PNG')
    return buf.getvalue()


def data_url(b, kind='jpeg'):
    return f'data:image/{kind};base64,' + base64.b64encode(b).decode()


def solve(token, bits):
    n = 0
    while True:
        h = hashlib.sha256(f'{token}:{n}'.encode()).digest()
        v = int.from_bytes(h, 'big')
        if v >> (256 - bits) == 0 if bits else True:
            return str(n)
        n += 1


def run(lib, check, admin_key):
    ip = lambda n: {'X-Forwarded-For': f'203.0.113.{n}'}
    bits = int(lib.sql_value('select pow_bits from public.library_settings'))

    def call(fn, body, n=1):
        try:
            return 200, lib.rpc(fn, body, ip(n)), ''
        except urllib.error.HTTPError as e:
            raw = e.read().decode()
            try:
                d = json.loads(raw)
            except Exception:
                d = {'message': raw}
            return e.code, d.get('message', ''), d.get('hint') or ''

    def publish(guide, pid=None, secret='S' * 32, n=1, pow_ok=True):
        ch = lib.rpc('get_challenge', {}, ip(n))
        nonce = solve(ch['token'], ch['bits']) if pow_ok else '1'
        return call('publish_guide', {'p_id': pid, 'p_secret': secret, 'p_guide': guide, 'p_token': ch['token'], 'p_nonce': nonce}, n)

    def report(gid, reason, n):
        ch = lib.rpc('get_challenge', {}, ip(n))
        return call('report_guide', {'p_id': gid, 'p_reason': reason, 'p_token': ch['token'], 'p_nonce': solve(ch['token'], ch['bits'])}, n)

    base = {'title': 'How to use the coffee machine', 'item': 'Office coffee machine', 'location': 'Kitchen',
            'steps': ['Fill the water tank', 'Put a cup under the spout', 'Press the large button'], 'notes': 'Clean the tray on Fridays.'}

    def g(**kw):
        d = json.loads(json.dumps(base))
        d.update(kw)
        return d

    def refused(name, result, status=400, hint=None, text=None):
        code, msg, h = result
        ok = code == status and (hint is None or h.startswith(hint)) and (text is None or text.lower() in str(msg).lower())
        check('Security: ' + name, ok, f'{code} {msg} {h}')

    # ---- a valid guide with a photo goes in, photo held for review
    code, r, _ = publish(g(photos=[{'src': data_url(jpeg()), 'step': 0}]))
    check('Security: a proper guide with a real photo is accepted', code == 200 and r['photos_pending'] == 1, r)
    gid = r['id'] if code == 200 else None
    got = lib.rpc('get_guide', {'p_id': gid})
    check('Security: photos stay hidden until an admin approves them', got['photos'] == [] and got['photos_pending'] == 1)

    # ---- only guide fields, only plain types
    refused('extra fields (data that isn’t a guide) are refused', publish(g(extra='hidden payload')), hint='shape')
    refused('a whole different object is refused', publish({'anything': 'else'}), hint='shape')
    refused('non-text steps are refused', publish(g(steps=['Open the lid', {'x': 1}])), hint='shape')
    refused('a number as the title is refused', publish(g(title=12345)), hint='shape')
    refused('extra keys inside a photo are refused', publish(g(photos=[{'src': data_url(jpeg((1, 2, 3))), 'step': 0, 'payload': 'x'}])), hint='shape')
    refused('an edit key with odd characters is refused', publish(g(), secret='bad key with spaces and {json}!!!!'), hint='secret')

    # ---- empty and junk
    refused('empty title is refused', publish(g(title='   ')), hint='short')
    refused('a title with no words is refused', publish(g(title='1234 5678')), hint='empty')
    refused('no steps is refused', publish(g(steps=[])), hint='empty')
    refused('a blank step is refused', publish(g(steps=['Open the lid', '   '])), hint='short')
    refused('a step of only symbols is refused', publish(g(steps=['Open the lid', '!!! ??? ...'])), hint='empty')
    refused('61 steps are refused', publish(g(steps=[f'Turn the knob to position {i}' for i in range(61)])), hint='long')
    refused('a 301-character step is refused', publish(g(steps=['Open ' + 'the lid ' * 40])), hint='long')
    refused('garbled scanning text is refused', publish(g(title='Qwrtz plkmn', steps=['xzkq vbnmtr plqwx', 'zzgrk tttpq mmnrz', 'krrtx bvcxz qwrtp'])), hint='junk')
    refused('padding with repeated steps is refused', publish(g(steps=['Press start', 'Press start', 'Press start', 'Wait', 'Press start'])), hint='repeat')

    # ---- hiding other data in text
    refused('links in steps are refused', publish(g(steps=['Open the lid', 'Go to https://evil.example/pay'])), hint='link')
    refused('bare website names are refused', publish(g(steps=['Open the lid', 'Pay at parkpay.xyz now'])), hint='link')
    refused('e-mail addresses are refused', publish(g(notes='Write to someone@example.org for a refund')), hint='email')
    refused('long data blobs in text are refused', publish(g(steps=['Open the lid', 'Token ' + base64.b64encode(b'x' * 60).decode()])), hint='blob')
    refused('invisible characters are refused', publish(g(steps=['Open​ the lid', 'Close it'])), hint='chars')
    refused('control characters are refused', publish(g(title='Coffee\x07 machine guide')), hint='chars')
    refused('blocked words are refused', publish(g(steps=['Open the lid', 'Free money inside'])), hint='blocked')

    # ---- photos must be genuine images
    j = jpeg((9, 9, 9))
    refused('a photo that isn’t a data URL is refused', publish(g(photos=[{'src': 'https://evil.example/x.jpg', 'step': None}])), hint='photo_type')
    refused('SVG images (which can carry scripts) are refused', publish(g(photos=[{'src': 'data:image/svg+xml;base64,' + base64.b64encode(b'<svg onload=alert(1)>').decode(), 'step': None}])), hint='photo_type')
    refused('a file pretending to be a JPEG is refused', publish(g(photos=[{'src': data_url(b'\xff\xd8\xff' + b'hidden zip data ' * 20 + b'\xff\xd9'[:1]), 'step': None}])), hint='photo_bad')
    refused('a real JPEG with extra data hidden after it is refused', publish(g(photos=[{'src': data_url(j + b'PK\x03\x04secret archive'), 'step': None}])), hint='photo_bad')
    refused('a PNG labelled as JPEG is refused', publish(g(photos=[{'src': data_url(png()), 'step': None}])), hint='photo_bad')
    code, r, _ = publish(g(title='How to use the coffee machine PNG', steps=['Fill the tank with cold water', 'Press start'], photos=[{'src': data_url(png(), 'png'), 'step': 1}]), n=2)
    check('Security: a real PNG photo is accepted', code == 200, r)
    big = jpeg((1, 1, 1), size=(1400, 1400), quality=100) + b''
    big = jpeg(size=(1200, 1200), quality=100)
    if len(big) <= 250 * 1024:  # make sure it's over the limit
        big = Image.effect_noise((600, 600), 100).convert('RGB')
        buf = io.BytesIO(); big.save(buf, 'JPEG', quality=100); big = buf.getvalue()
    refused('a photo over 250 KB is refused', publish(g(photos=[{'src': data_url(big), 'step': None}])), hint='photo_big')
    refused('more than 4 photos are refused', publish(g(photos=[{'src': data_url(jpeg((i * 40, 0, 0))), 'step': None} for i in range(5)])), hint='photos_many')
    refused('the same photo twice is refused', publish(g(photos=[{'src': data_url(j), 'step': None}, {'src': data_url(j), 'step': None}])), hint='photo_dup')
    refused('a photo attached to a missing step is refused', publish(g(photos=[{'src': data_url(j), 'step': 7}])), hint='photo_step')

    # ---- duplicates
    dup = g(title='Coffee machine at work', steps=['fill the WATER tank!', 'Put a cup under the spout.', 'press the large button'])
    refused('the same steps under a different title are refused as a duplicate', publish(dup, n=3), status=409, hint='duplicate:' + gid)
    code, r2, _ = publish(g(title='How to use the kettle', steps=['Fill the kettle', 'Press the switch down', 'Wait for the click']), n=3)
    kettle = r2['id'] if code == 200 else None
    refused('editing a guide into a copy of another is refused', publish(g(steps=base['steps']), pid=kettle, n=3), status=409, hint='duplicate:')

    # ---- proof of work
    refused('publishing without solving the puzzle is refused', call('publish_guide', {'p_id': None, 'p_secret': 'S' * 32, 'p_guide': g(steps=['Lift the lid', 'Add beans'])}), hint='pow')
    if bits >= 4:
        refused('a wrong puzzle answer is refused', publish(g(steps=['Lift the lid', 'Add the beans']), pow_ok=False), hint='pow')
    ch = lib.rpc('get_challenge', {}, ip(4))
    nonce = solve(ch['token'], ch['bits'])
    first = call('publish_guide', {'p_id': None, 'p_secret': 'S' * 32, 'p_guide': g(title='How to use the toaster', steps=['Put bread in the slots', 'Push the lever down']), 'p_token': ch['token'], 'p_nonce': nonce}, 4)
    again = call('publish_guide', {'p_id': None, 'p_secret': 'S' * 32, 'p_guide': g(title='How to use the blender', steps=['Put the lid on', 'Hold the pulse button']), 'p_token': ch['token'], 'p_nonce': nonce}, 4)
    check('Security: each puzzle can only be used once', first[0] == 200 and again[0] == 400 and again[2] == 'pow', (first, again))

    # ---- updates: only with the edit key; photo changes go back to review
    refused('changing someone else’s guide is refused', publish(g(title='Hijacked coffee guide'), pid=gid, secret='W' * 32, n=5), status=403, hint='not_owner')
    lib.rpc('admin_act', {'p_key': admin_key, 'p_id': gid, 'p_action': 'approve_photos'})
    check('Security: approved photos become visible', len(lib.rpc('get_guide', {'p_id': gid})['photos']) == 1)
    code, r, _ = publish(g(title='How to use the coffee machine well', photos=[{'src': data_url(jpeg()), 'step': 0}]), pid=gid)
    check('Security: text-only edits keep photo approval', code == 200 and len(lib.rpc('get_guide', {'p_id': gid})['photos']) == 1, r)
    code, r, _ = publish(g(photos=[{'src': data_url(jpeg((0, 0, 200))), 'step': 0}]), pid=gid)
    check('Security: new photos go back to review', code == 200 and lib.rpc('get_guide', {'p_id': gid})['photos'] == [] and r['photos_pending'] == 1, r)

    # ---- rate limits and capacity
    lib.sql('update public.library_settings set publish_per_client_hour = 2')
    a = publish(g(title='How to use the microwave', steps=['Open the door', 'Set the timer']), n=20)
    b = publish(g(title='How to use the dishwasher', steps=['Load the racks', 'Add a tablet']), n=20)
    c = publish(g(title='How to use the fridge', steps=['Open the door slowly', 'Check the dial']), n=20)
    check('Security: one network can only publish a few guides per hour', a[0] == 200 and b[0] == 200 and c[0] == 429, c)
    d = publish(g(title='How to use the fridge', steps=['Open the door slowly', 'Check the dial']), n=21)
    check('Security: other networks are not affected', d[0] == 200, d)
    lib.sql('update public.library_settings set publish_per_client_hour = 1000, publish_global_hour = 1')
    refused('an overall hourly limit protects the library', publish(g(title='How to use the oven', steps=['Turn the dial', 'Wait for the light']), n=22), status=429, hint='rate_global')
    lib.sql('update public.library_settings set publish_global_hour = 100000, max_library_mb = 0')
    refused('publishing stops before the database is full', publish(g(title='How to use the oven', steps=['Turn the dial', 'Wait for the light']), n=23), status=503, hint='full')
    lib.sql('update public.library_settings set max_library_mb = 350')

    # ---- reports: once per network; enough networks hide it; admin can restore and protect
    for _ in range(3):
        report(kettle, 'spam', 30)
    check('Security: many reports from one network count once', len(lib.rpc('search_guides', {'q': 'kettle'})) == 1)
    refused('a made-up report reason is refused', call('report_guide', {'p_id': kettle, 'p_reason': 'my free text payload'}, 31), hint='reason')
    report(kettle, 'offensive', 31); report(kettle, 'wrong', 32)
    check('Security: reports from 3 different networks hide a guide', lib.rpc('search_guides', {'q': 'kettle'}) == [] and lib.rpc('get_guide', {'p_id': kettle}) is None)
    q = lib.rpc('admin_queue', {'p_key': admin_key, 'p_view': 'review', 'p_q': ''})
    item = next((x for x in q if x['id'] == kettle), None)
    check('Security: hidden guides appear in the admin review list with reasons', item is not None and item['hidden'] and sorted(item['reasons']) == ['offensive', 'spam', 'wrong'], item)
    lib.rpc('admin_act', {'p_key': admin_key, 'p_id': kettle, 'p_action': 'protect'})
    for n in (40, 41, 42):
        report(kettle, 'spam', n)
    check('Security: a guide the admin marked as fine can’t be hidden by reports again', len(lib.rpc('search_guides', {'q': 'kettle'})) == 1)

    # ---- downloads counted once per network
    for _ in range(3):
        call('count_download', {'p_id': kettle}, 50)
    call('count_download', {'p_id': kettle}, 51)
    check('Security: download counts can’t be inflated from one network', lib.rpc('get_guide', {'p_id': kettle})['downloads'] == 2)

    # ---- bans
    lib.rpc('admin_act', {'p_key': admin_key, 'p_id': r2['id'] if False else a[1]['id'], 'p_action': 'ban'})
    refused('a banned network can’t publish', publish(g(title='How to use the iron', steps=['Fill the water', 'Set the heat']), n=20), status=403, hint='banned')
    check('Security: banning hides that publisher’s guides', lib.rpc('search_guides', {'q': 'microwave'}) == [] and lib.rpc('search_guides', {'q': 'dishwasher'}) == [])

    # ---- blocked words are managed by the admin
    lib.rpc('admin_blocklist', {'p_key': admin_key, 'p_add': 'scamword'})
    refused('words the admin blocks are refused', publish(g(title='How to use the scamword machine', steps=['Lift the lid', 'Press go']), n=60), hint='blocked')
    lib.rpc('admin_blocklist', {'p_key': admin_key, 'p_remove': 'scamword'})
    code, _, _ = publish(g(title='How to use the scamword machine', steps=['Lift the lid', 'Press go']), n=60)
    check('Security: unblocking a word allows it again', code == 200)

    # ---- admin powers need the key; internals are unreachable
    refused('admin actions need the admin key', call('admin_act', {'p_key': 'guess', 'p_id': gid, 'p_action': 'delete'}, 70), status=403, hint='admin')
    refused('the admin list needs the admin key', call('admin_queue', {'p_key': '', 'p_view': 'all', 'p_q': ''}, 70), status=403, hint='admin')
    refused('settings can only be changed with the admin key', call('admin_settings', {'p_key': 'nope', 'p_changes': {'pow_bits': 0}}, 70), status=403, hint='admin')
    refused('unknown settings can’t be written even by the admin', call('admin_settings', {'p_key': admin_key, 'p_changes': {'salt': 1}}, 70), hint='setting')
    tables = ['library_guides', 'library_reports', 'library_events', 'library_challenges', 'library_bans',
              'library_blocklist', 'library_admins', 'library_settings']
    statuses = {t: lib.get(f'{t}?select=*')[0] for t in tables}
    check('Security: no table can be read through the API', all(s in (401, 403, 404) for s in statuses.values()), statuses)

    writes = []
    for t in ('library_guides', 'library_admins', 'library_settings'):
        try:
            urllib.request.urlopen(urllib.request.Request(f'{lib.url}/{t}', data=b'{}', headers={'Content-Type': 'application/json'}, method='POST'))
            writes.append((t, 200))
        except urllib.error.HTTPError as e:
            writes.append((t, e.code))
    check('Security: no table can be written through the API', all(code in (401, 403, 404) for _, code in writes), writes)
    hidden_fns = [call(fn, {}, 71)[0] for fn in ('admin_new_key', 'fail', 'client', 'check_text', 'rate')]
    check('Security: internal helpers (including creating admin keys) can’t be called', all(c == 404 for c in hidden_fns), hidden_fns)
    leak = json.dumps(lib.rpc('get_guide', {'p_id': kettle})) + json.dumps(lib.rpc('search_guides', {'q': ''}))
    check('Security: public results never include edit-key hashes or network hashes', 'secret' not in leak and 'publisher' not in leak and 'fingerprint' not in leak)
    lib.rpc('admin_act', {'p_key': admin_key, 'p_id': kettle, 'p_action': 'delete'})
    check('Security: the admin can remove any guide (for lost edit keys)', lib.rpc('get_guide', {'p_id': kettle}) is None)
