# OpenClaw connector

The OpenClaw connector lets AI Connect drive an OpenClaw agent running on your own machine — sending it messages and using its local tools through AI Connect's interface.

## What makes it different

Most connectors — WordPress, SendGrid, Auth0, Stripe — are network APIs that AI Connect's cloud backend calls directly. OpenClaw is different. It runs on your local machine, and its bridge speaks a local-only transport (MCP over stdio, no network). So AI Connect can only drive OpenClaw if AI Connect *itself* is running on the same host.

That's what **local mode** is: AI Connect's same codebase running on your machine, with an environment flag that enables local-only integrations like OpenClaw.

In cloud mode, the OpenClaw option is visible but disabled — it shows a "local mode only" badge and greys out its action buttons. Cloud and local AI Connect share the same database, so any integration you create is visible in both places; the cloud simply refuses to *call* OpenClaw-type integrations.

## When you need it

Use the OpenClaw connector when you want AI Connect to talk to a local OpenClaw agent. You do **not** need it (or local mode) for WordPress, SendGrid, OpenAI, Anthropic, Project Genesis, or most other AI Connect work — the cloud handles all of those.

## Getting started

Setting up OpenClaw means running AI Connect in local mode first. The full walkthrough — prerequisites, environment setup, the connection wizard, security notes, and troubleshooting — is in [OpenClaw local mode](#openclaw-local-mode).

Once local mode is verified, adding the integration is a short wizard: enter your bridge path, let AI Connect discover your agents, pick a default, send a test message, and you're connected.

## Security in brief

The OpenClaw connector gives AI Connect the agent's full local powers (file system, shell, tools) *through* the agent — so only enable it on a machine you control. AI Connect enforces read-only mode at every bridge spawn, so it can't call mutating tools even with a bug. See [OpenClaw local mode](#openclaw-local-mode) for the complete security model.
