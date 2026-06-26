# wink-cli Skill Installer

Installs the Wink CLI Agent Skill into:

```text
~/.agents/skills/wink-cli/
```

## Usage

From this repository:

```bash
npx ./skills/wink-cli install --force
```

After publishing the package:

```bash
npx wink-cli install
```

On Windows, `install` and `update` also query the Wink uninstall registry key to
locate the installed app. If `<install-root>/Wink/<version>/cli/wink.cmd` is
missing, the installer creates it with the same `Wink.exe --cli` wrapper used by
the NSIS package. Writing under `Program Files` may trigger a UAC elevation
prompt; approve it to finish creating `wink.cmd`.

## Commands

```bash
npx wink-cli install
npx wink-cli install --force
npx wink-cli update
npx wink-cli uninstall
```

Use `--dest <path>` to install under a different home directory. The final skill path is:

```text
<path>/.agents/skills/wink-cli/
```
