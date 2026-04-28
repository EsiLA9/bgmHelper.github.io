#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import argparse
import csv
import sys
import time
from pathlib import Path

import requests


DEFAULT_MAPPING_CSV = "bgm小工具的映射表 20260421.csv"
DEFAULT_OUTPUT_CSV = "introduction.csv"
API_URL_TEMPLATE = "https://api.kivo.wiki/api/v1/musics/{database_id}"
CSV_ENCODING = "utf-8-sig"
INTRODUCTION_SPLIT_MARKERS = (
    "该曲曾用于：",
    "该曲曾用于:",
    "此曲曾用于：",
    "此曲曾用于:",
)
SUCCESS_CODES = {2000}


def parse_args():
    parser = argparse.ArgumentParser(
        description="根据映射表批量抓取 kivo.wiki 曲目简介，并缓存到本地 CSV。"
    )
    parser.add_argument(
        "--mapping",
        default=DEFAULT_MAPPING_CSV,
        help=f"映射表路径，默认: {DEFAULT_MAPPING_CSV}",
    )
    parser.add_argument(
        "--output",
        default=DEFAULT_OUTPUT_CSV,
        help=f"输出缓存 CSV 路径，默认: {DEFAULT_OUTPUT_CSV}",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=15.0,
        help="单次请求超时秒数，默认: 15",
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=0.25,
        help="每次请求之间的等待秒数，默认: 0.25",
    )
    parser.add_argument(
        "--retries",
        type=int,
        default=2,
        help="失败后的额外重试次数，默认: 2",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="只抓取前 N 个 ID，0 表示不限制，便于测试",
    )
    parser.add_argument(
        "--refresh",
        action="store_true",
        help="忽略已有输出缓存，重新抓取全部条目",
    )
    return parser.parse_args()


def load_mapping_rows(mapping_path):
    mapping_path = Path(mapping_path)
    if not mapping_path.exists():
        raise FileNotFoundError(f"找不到映射表: {mapping_path}")

    unique_rows = {}
    with mapping_path.open("r", encoding=CSV_ENCODING, newline="") as handle:
        reader = csv.DictReader(handle)
        if "database_id" not in (reader.fieldnames or []):
            raise ValueError("映射表缺少 database_id 列")

        for row in reader:
            database_id = f"{row.get('database_id', '')}".strip()
            if not database_id:
                continue

            if database_id not in unique_rows:
                unique_rows[database_id] = {
                    "database_id": database_id,
                    "dev_code": f"{row.get('dev_code', '')}".strip(),
                    "mapping_title": f"{row.get('title', '')}".strip(),
                }

    return list(unique_rows.values())


def load_existing_output(output_path):
    output_path = Path(output_path)
    existing_rows = {}
    if not output_path.exists():
        return existing_rows

    with output_path.open("r", encoding=CSV_ENCODING, newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            database_id = f"{row.get('database_id', '')}".strip()
            if database_id:
                existing_rows[database_id] = row
    return existing_rows


def sanitize_introduction(text):
    normalized = normalize_line_endings(text).strip()
    if not normalized:
        return ""

    marker_index = None
    for marker in INTRODUCTION_SPLIT_MARKERS:
        current_index = normalized.find(marker)
        if current_index >= 0 and (marker_index is None or current_index < marker_index):
            marker_index = current_index

    if marker_index is not None:
        normalized = normalized[:marker_index].rstrip()

    return normalized.strip()


def normalize_line_endings(text):
    return f"{text}".replace("\r\n", "\n").replace("\r", "\n")


def fetch_music_payload(session, database_id, timeout, retries):
    last_error = None
    for attempt in range(retries + 1):
        try:
            response = session.get(
                API_URL_TEMPLATE.format(database_id=database_id),
                timeout=timeout,
            )
            response.raise_for_status()
            payload = response.json()
            if payload.get("code") not in SUCCESS_CODES or not payload.get("success", False):
                raise RuntimeError(payload.get("message") or f"接口返回异常: {payload.get('code')}")
            return payload
        except Exception as error:
            last_error = error
            if attempt >= retries:
                break
            time.sleep(min(1.5, 0.4 * (attempt + 1)))

    raise last_error


def build_output_row(source_row, payload):
    data = payload.get("data") or {}
    cleaned_introduction = sanitize_introduction(data.get("introduction", ""))
    return {
        "database_id": source_row["database_id"],
        "dev_code": source_row["dev_code"],
        "mapping_title": source_row["mapping_title"],
        "api_title": normalize_line_endings(data.get("title", "")).strip(),
        "introduction": cleaned_introduction,
        "status": "ok" if cleaned_introduction else "empty",
        "error": "",
    }


def build_error_row(source_row, error):
    return {
        "database_id": source_row["database_id"],
        "dev_code": source_row["dev_code"],
        "mapping_title": source_row["mapping_title"],
        "api_title": "",
        "introduction": "",
        "status": "error",
        "error": normalize_line_endings(str(error)).strip(),
    }


def write_output(output_path, rows):
    fieldnames = [
        "database_id",
        "dev_code",
        "mapping_title",
        "api_title",
        "introduction",
        "status",
        "error",
    ]

    output_path = Path(output_path)
    with output_path.open("w", encoding=CSV_ENCODING, newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def main():
    args = parse_args()
    mapping_rows = load_mapping_rows(args.mapping)
    existing_rows = {} if args.refresh else load_existing_output(args.output)

    if args.limit > 0:
        mapping_rows = mapping_rows[:args.limit]

    total_count = len(mapping_rows)
    if total_count == 0:
        print("没有可抓取的 database_id。")
        return 0

    session = requests.Session()
    session.headers.update({
        "Accept": "application/json, text/plain, */*",
        "User-Agent": "bgmHelper-introduction-cache/1.0",
    })

    result_rows = []
    ok_count = 0
    empty_count = 0
    error_count = 0
    reused_count = 0

    try:
        for index, source_row in enumerate(mapping_rows, start=1):
            database_id = source_row["database_id"]
            existing_row = existing_rows.get(database_id)

            if existing_row and existing_row.get("status") in {"ok", "empty"}:
                reused_count += 1
                result_rows.append(merge_existing_row(source_row, existing_row))
                print(f"[{index}/{total_count}] {database_id}: 使用已有缓存 ({existing_row.get('status')})")
                continue

            print(f"[{index}/{total_count}] {database_id}: 抓取中...")
            try:
                payload = fetch_music_payload(
                    session=session,
                    database_id=database_id,
                    timeout=args.timeout,
                    retries=args.retries,
                )
                row = build_output_row(source_row, payload)
                if row["status"] == "ok":
                    ok_count += 1
                    print(f"  -> 成功，清洗后简介长度 {len(row['introduction'])}")
                else:
                    empty_count += 1
                    print("  -> 成功，但简介为空")
            except Exception as error:
                row = build_error_row(source_row, error)
                error_count += 1
                print(f"  -> 失败: {row['error']}")

            result_rows.append(row)
            write_output(args.output, sort_rows(result_rows))

            if args.delay > 0 and index < total_count:
                time.sleep(args.delay)
    finally:
        session.close()

    final_rows = sort_rows(result_rows)
    write_output(args.output, final_rows)

    print()
    print(f"完成，输出文件: {args.output}")
    print(f"总数: {total_count}")
    print(f"复用缓存: {reused_count}")
    print(f"成功: {ok_count}")
    print(f"空简介: {empty_count}")
    print(f"失败: {error_count}")
    return 0 if error_count == 0 else 1


def merge_existing_row(source_row, existing_row):
    merged = dict(existing_row)
    merged["database_id"] = source_row["database_id"]
    merged["dev_code"] = source_row["dev_code"]
    merged["mapping_title"] = source_row["mapping_title"]
    return merged


def sort_rows(rows):
    return sorted(rows, key=lambda row: parse_sort_id(row.get("database_id", "")))


def parse_sort_id(value):
    try:
        return int(str(value).strip())
    except Exception:
        return sys.maxsize


if __name__ == "__main__":
    raise SystemExit(main())
