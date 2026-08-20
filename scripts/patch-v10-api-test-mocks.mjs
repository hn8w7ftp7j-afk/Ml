import fs from 'node:fs';

const path = 'scripts/api-integrity-v942-route-test.mjs';
const source = fs.readFileSync(path, 'utf8');
const anchor = "  globalThis.fetch = async url => {\n    const target = String(url);\n";
if (!source.includes(anchor)) throw new Error('V10 API mock patch anchor missing');
if (source.includes('V10_POINT_IN_TIME_TEST_FIXTURES')) {
  console.log('V10 API mocks already patched');
  process.exit(0);
}

const injected = String.raw`  globalThis.fetch = async url => {
    const target = String(url);
    // V10_POINT_IN_TIME_TEST_FIXTURES: deterministic official-data fixtures for the new data gate.
    const targetUrl = new URL(target);
    const targetPath = targetUrl.pathname;

    if (targetPath === '/api/v1/venues/13') {
      return new Response(JSON.stringify({ venues: [{
        id: 13,
        name: 'Rogers Centre',
        location: {
          defaultCoordinates: { latitude: 43.6414, longitude: -79.3894 },
          city: 'Toronto', stateAbbrev: 'ON', country: 'Canada',
        },
        fieldInfo: { roofType: 'Retractable' },
        timeZone: { id: 'America/Toronto' },
      }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    if (/^\/api\/v1\/teams\/(?:111|141)\/roster$/.test(targetPath)) {
      return new Response(JSON.stringify({ roster: [] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }

    if (targetPath === '/api/v1/teams/stats') {
      const group = targetUrl.searchParams.get('group') || 'hitting';
      const splits = Array.from({ length: 30 }, (_, index) => ({
        team: { id: index + 1, name: 'Test Team ' + (index + 1) },
        stat: group === 'pitching'
          ? {
            gamesPlayed: index < 18 ? 123 : 122,
            gamesPitched: index < 18 ? 123 : 122,
            inningsPitched: index % 2 ? '1098.2' : '1099.1',
            runs: 540 + index % 4,
            earnedRuns: 515 + index % 4,
            strikeOuts: 1080 + index,
            baseOnBalls: 365 + index % 5,
            homeRuns: 138 + index % 3,
            hits: 1040 + index,
          }
          : {
            gamesPlayed: index < 18 ? 123 : 122,
            plateAppearances: 4550,
            atBats: 4050,
            runs: 545 + index % 6,
            hits: 1010 + index,
            doubles: 200,
            triples: 20,
            homeRuns: 145 + index % 4,
            strikeOuts: 950,
            baseOnBalls: 390,
            avg: '.249',
            obp: '.322',
            slg: '.418',
          },
      }));
      return new Response(JSON.stringify({ stats: [{ group: { displayName: group }, splits }] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }

    if (targetPath === '/api/v1/schedule' && targetUrl.searchParams.has('teamId')) {
      const teamId = Number(targetUrl.searchParams.get('teamId')) || 141;
      const games = [];
      for (let index = 0; index < 25; index += 1) {
        const day = String(index + 1).padStart(2, '0');
        games.push({
          gamePk: 910000 + index * 2,
          gameDate: '2099-06-' + day + 'T23:00:00Z',
          status: { abstractGameState: 'Final', codedGameState: 'F' },
          venue: { id: 13, name: 'Rogers Centre' },
          teams: {
            home: { team: { id: teamId, name: 'Toronto Blue Jays' }, score: 6 },
            away: { team: { id: 200 + index, name: 'Road Team ' + index }, score: 4 },
          },
        });
        games.push({
          gamePk: 910001 + index * 2,
          gameDate: '2099-07-' + day + 'T23:00:00Z',
          status: { abstractGameState: 'Final', codedGameState: 'F' },
          venue: { id: 500 + index, name: 'Road Park ' + index },
          teams: {
            home: { team: { id: 300 + index, name: 'Home Team ' + index }, score: 4 },
            away: { team: { id: teamId, name: 'Toronto Blue Jays' }, score: 5 },
          },
        });
      }
      return new Response(JSON.stringify({ dates: [{ games }] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }

    if (/^https:\/\/(?:api|archive-api)\.open-meteo\.com\/v1\/(?:forecast|archive)/.test(target)) {
      return new Response(JSON.stringify({ hourly: {
        time: ['2099-08-11T22:00', '2099-08-11T23:00', '2099-08-12T00:00'],
        temperature_2m: [23, 24, 23],
        relative_humidity_2m: [55, 54, 56],
        precipitation_probability: [0, 0, 0],
        surface_pressure: [1008, 1007, 1008],
        wind_speed_10m: [8, 9, 8],
        wind_direction_10m: [180, 185, 190],
      } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
`;

fs.writeFileSync(path, source.replace(anchor, injected));
console.log('V10 API test mocks patched');
