---
name: ada-ssh
description: Use this skill whenever the user wants to run something on ada, SSH into ada, execute code on ada's GPU, copy files to/from ada, or check ada's GPU status. Ada is a remote GPU server (3x NVIDIA RTX 6000 Ada Generation) accessed via SSH through a tesla jump host. Trigger on: "run on ada", "use ada's GPU", "ssh to ada", "do this on ada", "copy to ada", "check ada".
---

# Ada SSH Skill

Ada is a remote GPU server with 3× NVIDIA RTX 6000 Ada Generation GPUs (49 GB each), accessed via SSH through tesla as a jump host.

## Connection details

- **SSH alias**: `ada` (configured in `~/.ssh/config`)
- **Jump host**: `tesla` → `ada` (10.40.18.12)
- **User**: `e19309`
- **Password**: read from `ADA_PASSWORD` environment variable at runtime
- **Conda env**: `~/miniconda3/envs/sllaw` (has surya-ocr, docling, torch+CUDA, transformers)
- **Work dir**: `~/sllaw_layout/`

Get the password like this:

```python
import os
password = os.environ["ADA_PASSWORD"]
```

If `ADA_PASSWORD` is not set, tell the user to set it:
```
export ADA_PASSWORD=<password>
```

## Connection mechanism

`sshpass` is not installed locally. Use **pexpect** to handle the two sequential password prompts (tesla first, then ada).

### Reusable connection helper

Always use this pattern to connect:

```python
import pexpect, os, time

def connect_ada():
    password = os.environ["ADA_PASSWORD"]
    child = pexpect.spawn('ssh -o StrictHostKeyChecking=no ada', timeout=60)
    for _ in range(2):  # handle tesla then ada password prompts
        i = child.expect(['assword:', r'\$ ', '# '], timeout=30)
        if i == 0:
            child.sendline(password)
            time.sleep(1)
        else:
            break
    child.expect([r'\$ ', '# '], timeout=30)
    return child

def run(child, cmd, timeout=120):
    child.sendline(cmd)
    child.expect([r'\$ ', '# '], timeout=timeout)
    return child.before.decode(errors='replace')

def close(child):
    child.sendline('exit')
    child.wait()
```

### Copying files to ada

Use pexpect with `scp` (not sshpass):

```python
def scp_to_ada(local_path, remote_path):
    password = os.environ["ADA_PASSWORD"]
    child = pexpect.spawn(f'scp -o StrictHostKeyChecking=no {local_path} ada:{remote_path}', timeout=60)
    for _ in range(2):
        i = child.expect(['assword:', pexpect.EOF, pexpect.TIMEOUT], timeout=30)
        if i == 0:
            child.sendline(password)
            time.sleep(1)
        else:
            break
    child.expect([pexpect.EOF, pexpect.TIMEOUT], timeout=60)
```

### Copying files from ada

```python
def scp_from_ada(remote_path, local_path):
    password = os.environ["ADA_PASSWORD"]
    child = pexpect.spawn(f'scp -o StrictHostKeyChecking=no ada:{remote_path} {local_path}', timeout=60)
    for _ in range(2):
        i = child.expect(['assword:', pexpect.EOF, pexpect.TIMEOUT], timeout=30)
        if i == 0:
            child.sendline(password)
            time.sleep(1)
        else:
            break
    child.expect([pexpect.EOF, pexpect.TIMEOUT], timeout=60)
```

## GPU selection

Ada has 3 GPUs. Check free memory and pick the least-used one:

```python
out = run(child, 'nvidia-smi --query-gpu=index,memory.free --format=csv,noheader')
# pick GPU with most free memory
best_gpu = sorted([(int(l.split(',')[0].strip()), int(l.split(',')[1].strip().split()[0]))
                   for l in out.strip().splitlines() if l.strip()],
                  key=lambda x: -x[1])[0][0]
```

Then prefix commands with `CUDA_VISIBLE_DEVICES=<best_gpu>`.

## Running long jobs

**Always use tmux** for any job that takes more than a few seconds. This ensures the job survives SSH disconnects and can be inspected later.

```python
# Start job in a named tmux session
run(child, "tmux new-session -d -s <session_name> '~/miniconda3/envs/sllaw/bin/python ~/sllaw/script.py > ~/sllaw/logs/run.log 2>&1'")

# Check status via pane capture
out = run(child, 'tmux capture-pane -t <session_name> -p')

# Or tail the log file
out = run(child, 'tail -20 ~/sllaw/logs/run.log')

# Kill a session
run(child, 'tmux kill-session -t <session_name> 2>/dev/null; true')
```

Never use `nohup ... &` — always use tmux instead.

## Retrieving output images

After a GPU run, scp results back locally:

```python
scp_from_ada('~/sllaw_layout/layout_output_docling_gpu/*.png', '/home/kavishka/sllaw/layout_output_docling_gpu/')
```

## Standard workflow

1. `connect_ada()` → get child (reads password from `ADA_PASSWORD` env var)
2. Check GPU free memory, pick least-used GPU
3. `scp_to_ada(script, '~/sllaw_layout/script.py')` if needed
4. `run(child, 'tmux new-session -d -s <name> "..."')` — always use tmux for long jobs
5. Check progress: `run(child, 'tmux capture-pane -t <name> -p')`
6. `scp_from_ada(results, local_dir)` to retrieve outputs
7. `close(child)`
