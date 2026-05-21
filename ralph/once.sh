#!/bin/bash
prompt=$(cat ralph/prompt.md)
claude --dangerously-skip-permissions "$prompt"
