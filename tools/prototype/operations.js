export const OPERATIONS = Object.freeze([
  { id: "first-light", number: "01", name: "첫 번째 섬광", region: "DUST VALLEY", difficulty: "입문", level: "easy", players: 2, seed: 85, description: "고요한 협곡에서 시작되는 첫 교전. 한 발을 쏘고, 바람과 무너진 지형이 남긴 답을 읽으세요.", objective: "1명의 AI와 5라운드 교전 · 누적 점수 1위", tip: "높은 각도는 언덕 너머를, 낮은 각도는 가까운 적을 겨눕니다." },
  { id: "fault-line", number: "02", name: "균열의 경계", region: "FAULTLINE BASIN", difficulty: "표준", level: "normal", players: 3, seed: 149, description: "세 포대가 마주한 분지. 단단한 암반과 느슨한 흙 사이에서 다음 한 발의 기회를 찾으세요.", objective: "2명의 AI와 5라운드 개인전 · 누적 점수 1위", tip: "파쇄탄으로 적의 발밑을 무너뜨리면 낙하 피해까지 노릴 수 있습니다." },
  { id: "last-horizon", number: "03", name: "마지막 지평선", region: "THE ASH FRONT", difficulty: "도전", level: "hard", players: 4, seed: 221, description: "물러설 곳 없는 네 포대의 전장. 남은 탄약, 상점의 선택, 한 번의 정확한 사격이 승부를 가릅니다.", objective: "3명의 AI와 5라운드 개인전 · 누적 점수 1위", tip: "지형은 라운드가 끝나도 남습니다. 다음 교전의 발판까지 생각하세요." },
]);

export const PROFILE_KEY = "neodeol.solo.profile.v1";

const safeCount = (value) => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 100000000) : 0;

export function normalizeProfile(value) {
  const profile = { version: 1, operations: {} };
  for (const operation of OPERATIONS) {
    const saved = value?.version === 1 ? value.operations?.[operation.id] : null;
    const completed = safeCount(saved?.completed);
    profile.operations[operation.id] = {
      completed,
      wins: Math.min(completed, safeCount(saved?.wins)),
      bestScore: safeCount(saved?.bestScore),
    };
  }
  return profile;
}

export function loadProfile(storage) {
  try {
    const raw = storage.getItem(PROFILE_KEY);
    const profile = normalizeProfile(raw ? JSON.parse(raw) : null);
    storage.setItem(PROFILE_KEY, JSON.stringify(profile));
    return { profile, persistent: true };
  } catch {
    return { profile: normalizeProfile(null), persistent: false };
  }
}

export function recordResult(profile, operationId, players) {
  const next = normalizeProfile(profile);
  const record = next.operations[operationId];
  const human = players.find((player) => player.slot === 0 && !player.isAI);
  if (!record || !human || players.length < 2 || !players.every((player) => Number.isFinite(player.score))) return next;
  const won = players.every((player) => player.slot === human.slot || player.score < human.score);
  record.completed = safeCount(record.completed + 1);
  record.wins = safeCount(record.wins + Number(won));
  record.bestScore = Math.max(record.bestScore, safeCount(human.score));
  return next;
}

export function saveProfile(storage, profile) {
  try {
    storage.setItem(PROFILE_KEY, JSON.stringify(normalizeProfile(profile)));
    return true;
  } catch {
    return false;
  }
}
