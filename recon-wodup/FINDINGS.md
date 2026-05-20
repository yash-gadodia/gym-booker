# Wodup Recon Findings

## URL Pattern for Date Navigation
- Base URL: `https://www.wodup.com/timeline?date=YYYY-MM-DD`
- Example: `https://www.wodup.com/timeline?date=2026-05-21`
- Authentication: Uses browser cookies (saved in wodup-auth.json)

## Workout Structure
Each date has a set of workouts identified by KIND (FIT, BURN, LIFT, STEAM, GYMNASTICS, RUN, CONDITIONING).

Sample extracted workout for 2026-05-21 (BURN):
```
Move Upper 4/8
A1. Incline Bench Dumbbell Front Raise 8-12-8-12-12-20
A2. Bent-Over Barbell Row 3 x 10
B1. Dual Dumbbell Shoulder Press 8-12-8-12-12-20
B2. Close Grip Bent Over Row 3 x 10
C1. Barbell Upright Row 8-12-8-12-12-20
C2. Bench Supported Reverse Fly 3 x 10
D. 4 minute EMOM of Dumbbell Hammer Curls and Close Grip Push-Ups
```

## DOM Structure
- Workouts appear as sections with "Log Result" button followed by workout content
- "Leaderboard" button follows "Log Result"
- "Show full workout" button at end of abbreviated workout
- Each workout is preceded by a kind identifier (FIT, BURN, LIFT, etc)

## Parsing Strategy
- Use Playwright to load the authenticated timeline page
- Parse `document.body.innerText` to extract lines
- Look for "Log Result" as workout marker
- Walk backwards to find KIND identifier
- Walk forwards to extract workout lines until next KIND or "Choose which programs"

## API vs DOM Scraping
No JSON API found. DOM scraping via Playwright is the way.

## Data Not Yet Posted
May 23 (2026-05-23) has no workouts posted yet - Wodup posts them dynamically.
