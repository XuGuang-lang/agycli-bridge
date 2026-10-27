# Repository guidance

This directory holds durable, repository-specific guidance for agents and
humans working in this repository.

## What belongs here

Markdown files under `.party/` are source-controlled. Read the files that
are relevant to the current task before changing this repository. When
normal work produces a verified fact that later sessions should reuse,
add or update a Markdown file here.

Typical contents:

- how to install dependencies and run the project locally
- required services, environment variable names, and networking notes
- repository-specific quirks that are easy to rediscover incorrectly

## What does not belong here

- Injected session skills and other ephemeral agent assets. Those live
  under `.agents/skills` and similar session-only paths, and must not be
  copied into this directory.
- Secret values, credentials, tokens, or anything that must not be
  committed. Record variable names only.

Keep guidance accurate and short. Prefer verified commands and constraints
over speculation.
