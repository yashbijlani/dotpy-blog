---
title: The joy of boring software
date: 2026-03-12
blurb: sqlite, a single binary, and a cron job. That is the whole architecture.
---

Everyone wants the distributed system. Nobody wants the 3am pager.

## What I actually run

- one binary
- one `sqlite` file
- one cron job

That is it. It has survived every rewrite I never did.

> The best infrastructure is the one you forget exists.

## The tradeoff

You give up horizontal scale. In return you get to keep the entire system in your head, which is a resource that does not autoscale either.

I have run out of cleverness more times than I have run out of disk.
