#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import csv
import ctypes
import os
import shutil
import tempfile
import tkinter as tk
import webbrowser
import zipfile
from tkinter import filedialog, messagebox

import py7zr
import rarfile


def enable_windows_dpi_awareness():
    """在 Windows 上启用 DPI 感知，避免 Tk 窗口被系统缩放后发虚。"""
    if os.name != 'nt':
        return

    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(1)
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass

class MDURLTool:
    def __init__(self, root):
        self.root = root
        self.root.title("📝 MD文件URL生成与内容复制工具 v2.0")
        self.root.geometry("1200x750")
        
        # 数据存储
        self.csv_mapping = {}
        self.md_files = {}
        self.current_file = None
        self.source_type = None
        self.clicked_files = set()  # 记录已双击处理过的文件名
        
        self.create_widgets()
    
    def create_widgets(self):
        """创建GUI界面 (保持原结构，仅微调文字)"""
        nav_frame = tk.LabelFrame(self.root, text="🔗 配置面板")
        nav_frame.pack(pady=5, padx=10, fill=tk.X)
        
        # Row 1: CSV
        csv_frame = tk.Frame(nav_frame)
        csv_frame.pack(pady=3, fill=tk.X)
        tk.Label(csv_frame, text="📊 CSV参考文件:", width=14, anchor='e').pack(side=tk.LEFT, padx=5)
        self.csv_path_var = tk.StringVar()
        tk.Entry(csv_frame, textvariable=self.csv_path_var, width=55, state='readonly').pack(side=tk.LEFT, padx=5)
        tk.Button(csv_frame, text="浏览...", command=self.select_csv, width=8).pack(side=tk.LEFT)
        tk.Button(csv_frame, text="🔄 加载CSV", command=self.load_csv, width=12, bg="#2196F3", fg="white").pack(side=tk.LEFT, padx=(5, 20))
        
        # Row 2: MD源 (新增 RAR/7z 描述)
        md_frame = tk.Frame(nav_frame)
        md_frame.pack(pady=3, fill=tk.X)
        tk.Label(md_frame, text="📁 MD文件源:", width=14, anchor='e').pack(side=tk.LEFT, padx=5)
        self.md_source_var = tk.StringVar()
        tk.Entry(md_frame, textvariable=self.md_source_var, width=55, state='readonly').pack(side=tk.LEFT, padx=5)
        tk.Button(md_frame, text="📂 文件夹", command=self.select_folder, width=10).pack(side=tk.LEFT)
        tk.Button(md_frame, text="📦 压缩包(Zip/7z/Rar)", command=self.select_archive, width=20).pack(side=tk.LEFT, padx=5)
        tk.Button(md_frame, text="🔄 加载MD", command=self.load_md_files, width=12, bg="#4CAF50", fg="white").pack(side=tk.LEFT, padx=(10, 20))
        
        # Row 3: URL及操作
        url_frame = tk.Frame(nav_frame, bg="#f5f5f5", relief=tk.SUNKEN, bd=1)
        url_frame.pack(pady=5, fill=tk.X, padx=5)
        tk.Label(url_frame, text="🌐 目标URL:", bg="#f5f5f5", font=("Microsoft YaHei", 9, "bold")).pack(side=tk.LEFT, padx=10)
        self.url_var = tk.StringVar(value="https://seminar.kivo.wiki/music/update/  ")
        tk.Entry(url_frame, textvariable=self.url_var, width=52, state='readonly', bg="white", font=("Consolas", 9)).pack(side=tk.LEFT, padx=5)
        tk.Button(url_frame, text="📋 复制内容", command=self.copy_current_content, width=14, bg="#FF9800", fg="white").pack(side=tk.LEFT, padx=10)
        tk.Button(url_frame, text="🔗 打开URL", command=self.open_url, width=10).pack(side=tk.LEFT)
        
        # 主体
        main_paned = tk.PanedWindow(self.root, orient=tk.HORIZONTAL, sashwidth=4, bg="#e0e0e0")
        main_paned.pack(pady=5, padx=10, fill=tk.BOTH, expand=True)
        
        # 左侧列表
        left_frame = tk.LabelFrame(main_paned, text="📋 MD文件总览 (双击标记已处理)")
        main_paned.add(left_frame, width=400)
        
        search_frame = tk.Frame(left_frame)
        search_frame.pack(pady=3, fill=tk.X, padx=5)
        self.search_var = tk.StringVar()
        self.search_var.trace_add('write', self.filter_files)
        search_entry = tk.Entry(search_frame, textvariable=self.search_var)
        search_entry.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=3)
        self.count_label = tk.Label(search_frame, text="(0)", fg="#666")
        self.count_label.pack(side=tk.RIGHT)
        
        self.file_listbox = tk.Listbox(left_frame, font=("Consolas", 10), selectbackground="#2196F3")
        self.file_listbox.pack(side=tk.LEFT, fill=tk.BOTH, expand=True, padx=5, pady=5)
        self.file_listbox.bind('<<ListboxSelect>>', self.on_file_select)
        self.file_listbox.bind('<Double-Button-1>', self.on_file_double_click)
        
        # 右侧预览
        right_frame = tk.LabelFrame(main_paned, text="📄 文件预览")
        main_paned.add(right_frame)
        self.right_frame_ref = right_frame
        
        preview_scroll_y = tk.Scrollbar(right_frame)
        preview_scroll_y.pack(side=tk.RIGHT, fill=tk.Y)
        preview_scroll_x = tk.Scrollbar(right_frame, orient=tk.HORIZONTAL)
        preview_scroll_x.pack(side=tk.BOTTOM, fill=tk.X)

        self.preview_text = tk.Text(
            right_frame,
            wrap=tk.NONE,
            font=("Consolas", 10),
            state='disabled',
            xscrollcommand=preview_scroll_x.set,
            yscrollcommand=preview_scroll_y.set
        )
        self.preview_text.pack(fill=tk.BOTH, expand=True, padx=5, pady=5)
        preview_scroll_y.config(command=self.preview_text.yview)
        preview_scroll_x.config(command=self.preview_text.xview)

        self.status_var = tk.StringVar(value="✅ 就绪")
        tk.Label(self.root, textvariable=self.status_var, bd=1, relief=tk.SUNKEN, anchor=tk.W).pack(side=tk.BOTTOM, fill=tk.X)

    # ─────────────────────────────────────────────────────────────
    # 新增/修改的功能函数
    # ─────────────────────────────────────────────────────────────

    def select_archive(self):
        """支持 zip, 7z, rar"""
        path = filedialog.askopenfilename(
            title="选择压缩包",
            filetypes=[("压缩文件", "*.zip *.7z *.rar"), ("所有文件", "*.*")]
        )
        if path:
            self.md_source_var.set(path)
            self.source_type = 'archive'
            self.status_var.set(f"📦 已选择压缩包: {os.path.basename(path)}")

    def load_md_files(self):
        source = self.md_source_var.get()
        if not source: return
        
        self.md_files = {}
        self.clicked_files = set() # 重置点击记录
        
        try:
            if self.source_type == 'folder':
                self._load_from_folder(source)
            elif self.source_type == 'archive':
                ext = os.path.splitext(source)[1].lower()
                if ext == '.zip':
                    self._load_from_zip(source)
                elif ext == '.7z':
                    self._load_from_7z(source)
                elif ext == '.rar':
                    self._load_from_rar(source)
            
            self.filter_files() # 刷新列表显示
            self.status_var.set(f"✅ 已加载 {len(self.md_files)} 个文件")
        except Exception as e:
            messagebox.showerror("加载错误", str(e))

    def _is_supported_text_file(self, file_name):
        return file_name.lower().endswith(('.md', '.txt'))

    def _store_file(self, file_name, raw_bytes, source, source_type):
        content = self._decode_content(raw_bytes)
        fname = os.path.splitext(os.path.basename(file_name))[0]
        self.md_files[fname] = {
            'content': content,
            'raw_content': content,
            'source': source,
            'type': source_type,
        }

    def _load_from_7z(self, path):
        """使用临时目录安全解压并加载 7z 中的 md 文件"""
        # 创建临时目录
        temp_dir = tempfile.mkdtemp()
        try:
            # 1. 解压所有内容到临时目录
            with py7zr.SevenZipFile(path, mode='r') as z:
                z.extractall(path=temp_dir)
            
            # 2. 遍历临时目录，读取 .md 文件
            for root, _, files in os.walk(temp_dir):
                for file in files:
                    if self._is_supported_text_file(file):
                        file_path = os.path.join(root, file)
                        
                        with open(file_path, 'rb') as f:
                            relative_path = os.path.relpath(file_path, temp_dir)
                            self._store_file(relative_path, f.read(), f"{path}:{relative_path}", '7z')
        except Exception as e:
            messagebox.showerror("7z 加载错误", f"无法解压或读取 7z 文件:\n{e}")
        finally:
            # 3. 确保临时文件被删除
            shutil.rmtree(temp_dir)

    def _load_from_rar(self, path):
        """处理 RAR，增加对目录的过滤"""
        try:
            with rarfile.RarFile(path) as rf:
                for info in rf.infolist():
                    if not info.isdir() and self._is_supported_text_file(info.filename):
                        with rf.open(info) as f:
                            self._store_file(info.filename, f.read(), f"{path}:{info.filename}", 'rar')
        except Exception as e:
            messagebox.showerror("RAR 加载错误", "请确保系统已安装 unrar 工具\n" + str(e))

    def _load_from_zip(self, path):
        """优化 ZIP 读取逻辑"""
        with zipfile.ZipFile(path, 'r') as zf:
            for info in zf.infolist():
                if not info.is_dir() and self._is_supported_text_file(info.filename):
                    with zf.open(info) as f:
                        self._store_file(info.filename, f.read(), f"{path}:{info.filename}", 'zip')

    def _load_from_folder(self, path):
        for root, _, files in os.walk(path):
            for f in files:
                if self._is_supported_text_file(f):
                    p = os.path.join(root, f)
                    with open(p, 'rb') as file:
                        self._store_file(f, file.read(), p, 'folder')

    def on_file_double_click(self, event):
        """双击逻辑：复制、打开、变绿"""
        selection = self.file_listbox.curselection()
        if not selection: return
        
        idx = selection[0]
        # 获取不带后缀的原始 key
        display_text = self.file_listbox.get(idx)
        raw_name = display_text.rsplit(' ', 1)[0]
        
        # 执行原有操作
        self.on_file_select(None)
        self.copy_current_content()
        self.open_url()
        
        # 记录并改变背景
        self.clicked_files.add(raw_name)
        self.file_listbox.itemconfigure(idx, bg="#C8E6C9", fg="#2E7D32") # 浅绿背景，深绿文字

    def filter_files(self, *args):
            """过滤并在重新填充时恢复绿色背景，按数字 ID 升序排序"""
            keyword = self.search_var.get().lower()
            self.file_listbox.delete(0, tk.END)
            
            # 存储格式: (文件名, 排序权重ID, 原始ID字符串)
            items = []
            for name in self.md_files.keys():
                if keyword in name.lower():
                    raw_db_id = self.csv_mapping.get(name, None)
                    
                    # 数字转换逻辑：
                    # 如果存在 ID 且是数字，则用数字排序
                    # 如果没有映射或不是数字，赋予一个极大值排在后面
                    try:
                        if raw_db_id is not None:
                            sort_key = int(raw_db_id)
                        else:
                            sort_key = float('inf')
                    except (ValueError, TypeError):
                        sort_key = float('inf')
                    
                    items.append((name, sort_key))
            
            # 排序：先按数字大小升序，ID 相同的按文件名字母排序
            items.sort(key=lambda x: (x[1], x[0]))

            for name, _ in items:
                status = "✓" if name in self.csv_mapping else "⚠"
                self.file_listbox.insert(tk.END, f"{name} {status}")
                
                # 恢复绿色背景
                if name in self.clicked_files:
                    curr_idx = self.file_listbox.size() - 1
                    self.file_listbox.itemconfigure(curr_idx, bg="#C8E6C9", fg="#2E7D32")
            
            # 更新计数
            self.count_label.config(text=f"({len(items)})")

    # ─────────────────────────────────────────────────────────────
    # 复用原有的工具函数 (select_csv, load_csv, copy_current_content, etc.)
    # ─────────────────────────────────────────────────────────────
    def select_csv(self):
        path = filedialog.askopenfilename(filetypes=[("CSV", "*.csv")])
        if path: self.csv_path_var.set(path)

    def load_csv(self):
        path = self.csv_path_var.get()
        if not path: return
        try:
            with open(path, 'r', encoding='utf-8-sig') as f:
                reader = csv.DictReader(f)
                self.csv_mapping = {row['dev_code']: row['database_id'] for row in reader if row.get('dev_code')}
            messagebox.showinfo("成功", f"加载了 {len(self.csv_mapping)} 条映射")
        except Exception as e: messagebox.showerror("错误", str(e))

    def on_file_select(self, event):
        selection = self.file_listbox.curselection()
        if not selection: return
        raw_name = self.file_listbox.get(selection[0]).rsplit(' ', 1)[0]
        self.current_file = raw_name
        content = self.md_files[raw_name]['content']
        
        self.preview_text.config(state='normal')
        self.preview_text.delete('1.0', tk.END)
        self.preview_text.insert('1.0', content)
        self.preview_text.config(state='disabled')
        self.right_frame_ref.config(text=f"📄 预览: {raw_name}.md")
        
        db_id = self.csv_mapping.get(raw_name)
        if db_id:
            self.url_var.set(f"https://seminar.kivo.wiki/music/update/{db_id}")
        else:
            self.url_var.set("〔⚠️ 无映射〕")

    def copy_current_content(self):
        if not self.current_file: return
        self.root.clipboard_clear()
        original_content = self.md_files[self.current_file]['raw_content']
        clipboard_content = original_content.replace('\r\n', '\n').replace('\r', '\n')
        self.root.clipboard_append(clipboard_content)
        self.root.update()
        self.status_var.set(f"📋 已复制原文件内容: {self.current_file}")

    def open_url(self):
        url = self.url_var.get()
        if "http" in url: webbrowser.open(url)

    def _decode_content(self, raw_bytes):
        for enc in ['utf-8', 'gbk', 'latin-1']:
            try: return raw_bytes.decode(enc)
            except: continue
        return ""

    def select_folder(self):
        path = filedialog.askdirectory()
        if path: 
            self.md_source_var.set(path)
            self.source_type = 'folder'

if __name__ == "__main__":
    enable_windows_dpi_awareness()
    root = tk.Tk()
    app = MDURLTool(root)
    root.mainloop()
