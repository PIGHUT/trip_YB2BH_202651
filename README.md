# 宜宾→北海换乘规划器

静态网页，支持：
- 城市勾选筛选
- 自定义换乘时间（同城异站）
- TopN 方案筛选
- 拖拽多维排序优先级
- 出发日抢票时间轨道

## 本地打开
直接打开 `index.html` 即可。

## Vercel
这是纯静态页面，导入仓库后直接部署即可。

## 返程爬虫（免OCR）
已提供 12306 抓取脚本（按配置线路抓车次、时刻、时长、价格并导出为页面可读的 JS 数据）：

1. 复制配置模板并修改返程日期、线路对：
`cp tools/return-config.example.json tools/return-config.json`
2. 运行抓取：
`node tools/fetch_12306_trips.mjs --config tools/return-config.json`
3. 输出文件默认是 `beihai-yibin-return-data.js`（变量名默认 `BEIHAI_YIBIN_RETURN_DATA`）。

备注：
- 若 12306 风控导致价格接口不返回，脚本会用 `defaultPrice`（默认 9999）兜底并在备注中标记。
- 起售时间使用配置中的 `saleTimeByStation` 填充（因为公开车次接口不稳定返回起售时间）。
