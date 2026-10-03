import pty, os, select, time, signal

pid, fd = pty.fork()
if pid == 0:
    os.chdir('/root/.hermes/profiles/nampa/cache/scratch/gitea-plugin')
    os.execvpe('npm', ['npm', 'publish', '--access', 'public'], dict(os.environ))

out = open('/root/.hermes/profiles/nampa/cache/scratch/gitea-plugin/.publish-pty.log', 'wb')
deadline = time.time() + 540
while time.time() < deadline:
    r, _, _ = select.select([fd], [], [], 1.0)
    if r:
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            break
        if not chunk:
            break
        out.write(chunk)
        out.flush()
        low = chunk.lower()
        if b'+ npmhoang' in chunk or b'published' in low or b'eotp' in low or b'e404' in low or b'error' in low:
            time.sleep(2)
            break
try:
    os.kill(pid, signal.SIGTERM)
except Exception:
    pass
