"""Runs a throwaway copy of the public library on this machine for tests:
Postgres 16 (the database Supabase uses) + PostgREST 12 (the API layer Supabase uses),
with Supabase's `anon` / `authenticated` roles and supabase/schema.sql applied.

Needs: Postgres server binaries (/usr/lib/postgresql/<ver>/bin) and a `postgrest` binary
(set POSTGREST=/path/to/postgrest, or put it on PATH).
Postgres refuses to run as root, so when run as root it uses a `pgtest` user.
"""
import glob, json, os, shutil, socket, subprocess, tempfile, time, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCHEMA = ROOT / 'supabase' / 'schema.sql'
PG_PORT = 54329
API_PORT = 3011


def _bin(name):
    found = sorted(glob.glob(f'/usr/lib/postgresql/*/bin/{name}'))
    if found:
        return found[-1]
    p = shutil.which(name)
    if not p:
        raise RuntimeError(f'{name} not found')
    return p


def _wait_port(port, timeout=20):
    end = time.time() + timeout
    while time.time() < end:
        s = socket.socket()
        if s.connect_ex(('127.0.0.1', port)) == 0:
            s.close()
            return
        s.close()
        time.sleep(0.2)
    raise RuntimeError(f'port {port} did not open')


class LocalLibrary:
    def __init__(self):
        self.dir = Path(tempfile.mkdtemp(prefix='htu-lib-'))
        self.procs = []
        self.as_user = []
        if os.geteuid() == 0:
            subprocess.run(['id', 'pgtest'], capture_output=True).returncode == 0 or \
                subprocess.run(['useradd', '-m', 'pgtest'], check=True)
            shutil.chown(self.dir, 'pgtest')
            self.as_user = ['runuser', '-u', 'pgtest', '--']
        self.url = f'http://127.0.0.1:{API_PORT}'

    def _psql(self, sql=None, file=None, db='postgres'):
        cmd = self.as_user + [_bin('psql'), '-h', str(self.dir), '-p', str(PG_PORT), '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1', '-q']
        cmd += ['-f', str(file)] if file else ['-c', sql]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode:
            raise RuntimeError(r.stderr)
        return r.stdout

    def start(self):
        data = self.dir / 'data'
        subprocess.run(self.as_user + [_bin('initdb'), '-D', str(data), '-U', 'postgres', '--auth=trust', '-E', 'UTF8'],
                       check=True, capture_output=True)
        self.procs.append(subprocess.Popen(
            self.as_user + [_bin('postgres'), '-D', str(data), '-p', str(PG_PORT), '-k', str(self.dir), '-c', 'listen_addresses=127.0.0.1'],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
        _wait_port(PG_PORT)
        time.sleep(0.5)
        # Supabase-like roles: the API connects as `authenticator` and switches to `anon`.
        self._psql("create role anon nologin; create role authenticated nologin; "
                   "create role authenticator login noinherit; grant anon, authenticated to authenticator; "
                   "grant usage on schema public to anon, authenticated;")
        # Supabase gives anon table rights by default; mimic that so the schema's revokes are really tested.
        self._psql("alter default privileges in schema public grant all on tables to anon, authenticated;")
        schema_copy = self.dir / 'schema.sql'
        shutil.copy(SCHEMA, schema_copy)
        if self.as_user:
            shutil.chown(schema_copy, 'pgtest')
        self._psql(file=schema_copy)
        self._psql(file=schema_copy)  # must be safe to run twice
        conf = self.dir / 'postgrest.conf'
        conf.write_text(
            f'db-uri = "postgres://authenticator@127.0.0.1:{PG_PORT}/postgres"\n'
            'db-schemas = "public"\ndb-anon-role = "anon"\n'
            f'server-port = {API_PORT}\nserver-host = "127.0.0.1"\n')
        postgrest = os.environ.get('POSTGREST') or shutil.which('postgrest')
        if not postgrest:
            raise RuntimeError('set POSTGREST=/path/to/postgrest')
        self.procs.append(subprocess.Popen([postgrest, str(conf)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
        _wait_port(API_PORT)
        for _ in range(50):  # wait for the schema cache
            try:
                self.rpc('search_guides', {'q': ''})
                break
            except Exception:
                time.sleep(0.2)
        return self

    def rpc(self, fn, body):
        req = urllib.request.Request(f'{self.url}/rpc/{fn}', data=json.dumps(body).encode(),
                                     headers={'Content-Type': 'application/json'}, method='POST')
        with urllib.request.urlopen(req, timeout=10) as r:
            raw = r.read()
            return json.loads(raw) if raw else None

    def get(self, path):
        try:
            with urllib.request.urlopen(f'{self.url}/{path}', timeout=10) as r:
                return r.status, r.read().decode()
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode()

    def sql(self, sql):
        return self._psql(sql)

    def stop(self):
        for p in reversed(self.procs):
            p.terminate()
            try:
                p.wait(5)
            except Exception:
                p.kill()
        shutil.rmtree(self.dir, ignore_errors=True)


if __name__ == '__main__':
    lib = LocalLibrary().start()
    print('library API running at', lib.url, '(Ctrl+C to stop)')
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        lib.stop()
