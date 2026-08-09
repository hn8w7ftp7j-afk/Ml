import { readFileSync } from 'node:fs';
const BASE='https://mlb-positive-ev.vercel.app';
const fixture=readFileSync(new URL('./fixtures/dense-board-7games.b64',import.meta.url),'utf8').replace(/\s+/g,'');
const schedule=[
[990001,'克里夫蘭守護者','芝加哥白襪','Cleveland Guardians','Chicago White Sox'],
[990002,'明尼蘇達雙城','密爾瓦基釀酒人','Minnesota Twins','Milwaukee Brewers'],
[990003,'芝加哥小熊','堪薩斯市皇家','Chicago Cubs','Kansas City Royals'],
[990004,'科羅拉多落磯','聖路易紅雀','Colorado Rockies','St. Louis Cardinals'],
[990005,'巴爾的摩金鶯','德州遊騎兵','Baltimore Orioles','Texas Rangers'],
[990006,'底特律老虎','舊金山巨人','Detroit Tigers','San Francisco Giants'],
[990007,'洛杉磯道奇','亞利桑那響尾蛇','Los Angeles Dodgers','Arizona Diamondbacks'],
].map(([gamePk,away,home,awayEnglish,homeEnglish])=>({gamePk,away,home,awayEnglish,homeEnglish,gameNumber:1,scheduledInnings:9}));
const response=await fetch(`${BASE}/api/vision`,{method:'POST',headers:{'Content-Type':'application/json',Origin:BASE,'Sec-Fetch-Site':'same-origin'},body:JSON.stringify({images:[`data:image/jpeg;base64,${fixture}`],schedule,boardPass:true,defaultWater:{全場讓分:0.95,全場大小:0.94,上半讓分:0.94,上半大小:0.93}})});
const text=await response.text();
console.log('STATUS',response.status); console.log(text);
if(!response.ok) process.exit(1);
