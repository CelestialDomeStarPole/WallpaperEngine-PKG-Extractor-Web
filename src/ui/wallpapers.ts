export interface Wallpaper {
  url: string;
  title: string;
}

/** 新增壁纸只需往数组里加一行 */
export const wallpapers: Wallpaper[] = [
  { url: 'https://media.starpole.cc.cd/i/4988b4b501cf762d', title: '未花 高马尾自拍' },
  { url: 'https://media.starpole.cc.cd/i/b9934b9eb480c38b', title: '星野 中秋桂月垂光' },
  { url: 'https://media.starpole.cc.cd/i/c52da7c8e34e85fd', title: '碧蓝航线三周年纪念' },
  { url: 'https://media.starpole.cc.cd/i/f08f02803ac3b6c8', title: '一起涂防晒吧' },
  { url: 'https://media.starpole.cc.cd/i/a1698bb8abab7647', title: '满穗 海洋馆' },
  { url: 'https://media.starpole.cc.cd/i/ea695337b23042a3', title: '橘望 橘光 三周年 其一' },
  { url: 'https://media.starpole.cc.cd/i/0dc3c7fb2276af47', title: '橘望 橘光 三周年 其二' },
];

export function randomWallpaper(): Wallpaper {
  return wallpapers[Math.floor(Math.random() * wallpapers.length)] ?? wallpapers[0];
}
