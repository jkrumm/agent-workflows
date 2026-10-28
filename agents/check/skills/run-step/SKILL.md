---
name: run-step
description: Run one validation command under an idle watchdog so a hung step fails alone instead of stalling the report.
---

Run each validation command as one shell call from your session directory:

    sh .opencode/skills/run-step/run-step.sh <working-directory> <idle-seconds> '<command>'

The script enters the working directory itself and prints the last 200 lines of output, then `run-step: exit <code>`
or `run-step: IDLE_TIMEOUT no output for <N>s`. It exits with the command's code, 124 when the watchdog killed it.
Quote the command so it arrives as one argument.
