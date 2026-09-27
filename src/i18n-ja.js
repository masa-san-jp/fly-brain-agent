// Japanese glosses shown next to the English UI text. English stays the primary label;
// the gloss is a smaller, dimmer <span class="ja"> so layouts keep their English widths.

export const ja = (text) => `<span class="ja">${text}</span>`;

export const PRESET_JA = {
  foraging: '採餌アリーナ',
  openfield: '開けた野外・餌が点在',
  predator: '捕食者ゾーン（周期的な接近脅威）',
  maze: '迷路（奥に餌）',
  social: '社会：5匹と餌1つ',
  agents: 'エージェント端末：匂いで誘う2台',
  courtship: '求愛：オスとメス',
};

export const GROUP_JA = {
  smell: '嗅覚', taste: '味覚', vision: '光受容体', loom: '接近検出', escape: '巨大繊維',
  walk: '前進', back: '後退', steer: '操舵', groom: '毛づくろい', court: '求愛回路',
  octopamine: 'オクトパミン（空腹）', feed: '摂食運動',
};

const BEHAVIOR_JA = [
  ['dead', '死亡'], ['righting', '起き上がり'], ['taking off', '離陸'], ['escape jump', '逃避ジャンプ'],
  ['singing (courtship)', '求愛歌'], ['courting', '求愛'], ['grooming', '毛づくろい'], ['feeding', '摂食'],
  ['walking backward', '後ずさり'], ['turning left', '左旋回'], ['turning right', '右旋回'], ['walking', '歩行'],
  ['proboscis extended', '口吻伸展'], ['standing', '静止'], ['flying', '飛行'], ['landing', '着地'],
];

/** "walking (proboscis out)" → "歩行・口吻伸展"; unknown labels get no gloss. */
export function behaviorJa(label = '') {
  if (!label) return '';
  const hit = BEHAVIOR_JA.find(([en]) => label.startsWith(en));
  if (!hit) return '';
  return hit[1] + (label.includes('(proboscis out)') ? '・口吻伸展' : '');
}

export const STATUS_JA = {
  'loading body model': '体のモデルを読み込み中',
  'writing connectome into shared memory': 'コネクトームを共有メモリに書き込み中',
  'writing connectome and optic-lobe model into shared memory': 'コネクトームと視葉モデルを共有メモリに書き込み中',
  'loading humanoid avatar and animations': '人型アバターとアニメーションを読み込み中',
};

export const BRIDGE_JA = {
  disabled: '無効', starting: '起動中', connecting: '接続中', connected: '接続済み',
  reconnecting: '再接続中', closed: '切断', error: 'エラー',
};
