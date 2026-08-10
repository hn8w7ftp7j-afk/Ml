from pathlib import Path

path = Path('app/page.js')
text = path.read_text()

old = '''export default function Home() {
  const initial = useMemo(() => loadCompactStore(), []);
  const [settings, setSettings] = useState(initial.settings);
  const [bets, setBets] = useState(initial.bets);
  const [tab, setTab] = useState('board');'''
new = '''export default function Home() {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [bets, setBets] = useState([]);
  const [storageReady, setStorageReady] = useState(false);
  const [tab, setTab] = useState('board');'''
if text.count(old) != 1:
    raise SystemExit(f'initial state block match count: {text.count(old)}')
text = text.replace(old, new, 1)

old = '''  useEffect(() => { saveCompactStore({ settings, bets }); }, [settings, bets]);
  useEffect(() => {
    requestJSON('/api/health', {}, 20000).then(setHealth).catch(() => setHealth(null));'''
new = '''  useEffect(() => {
    const initial = loadCompactStore();
    setSettings(initial.settings);
    setBets(initial.bets);
    setStorageReady(true);
  }, []);
  useEffect(() => {
    if (storageReady) saveCompactStore({ settings, bets });
  }, [settings, bets, storageReady]);
  useEffect(() => {
    requestJSON('/api/health', {}, 20000).then(setHealth).catch(() => setHealth(null));'''
if text.count(old) != 1:
    raise SystemExit(f'useEffect block match count: {text.count(old)}')
text = text.replace(old, new, 1)

path.write_text(text)
print('v9.2 Safari-safe deterministic hydration applied')
