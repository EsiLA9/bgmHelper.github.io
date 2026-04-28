# bgmHelper.github.io

快速 bgm 施工器网页版。

## 当前版本

当前仓库已经提供一个纯静态前端版本，适合直接部署到 GitHub Pages：

- 自动读取仓库内的 `bgm小工具的映射表 20260326.csv`
- 支持导入本地文件夹或多选 `.md` / `.txt`
- 支持读取压缩包中的 `.md` / `.txt`
- 按 `database_id` 排序并支持搜索
- 自动读取仓库内的 `introduction.csv`，按 `database_id` 把 `introduction` 以“简介 + 空行 + 原文”的形式拼到文本前
- 预览拼接后的文本内容并复制结果
- 可手动标记文件为已处理

## 使用方式

1. 打开网页后，默认会尝试加载仓库里的 CSV 映射表。
2. 通过“导入文件夹”或“导入文件”选择本地歌词文件。
3. 如果内容在压缩包中，直接使用“导入压缩包”。
4. 在左侧列表中选择条目，右侧会显示拼接预览与拼接情况。
5. 点击“复制内容”或“双击列表项”即可进入处理流程。

## 暂未覆盖

浏览器版现在已经支持常见压缩包读取，但暂时还不支持带密码的压缩包。

## 本地缓存简介

如果浏览器端受跨域限制，建议先在本地批量抓取曲目简介缓存：

```bash
python fetch_introduction_cache.py
```

常用参数：

- `--mapping`：指定映射表 CSV
- `--output`：指定输出的 `introduction.csv`
- `--limit 20`：先抓前 20 条做测试
- `--refresh`：忽略已有缓存，重新抓取全部

输出文件会包含：

- `database_id`
- `dev_code`
- `mapping_title`
- `api_title`
- `introduction`（已清洗，只保留“该曲/此曲曾用于：”之前的内容）
- `status`
- `error`
