#!/usr/bin/env python3
"""QuickClip COS 发布工具 — 上传安装包和版本信息到腾讯云 COS。

使用方式:
    export COS_SECRET_ID=AKIDxxx
    export COS_SECRET_KEY=xxx
    python3 upload_to_cos.py                          # 上传 latest.json
    python3 upload_to_cos.py --file QuickClip-0.1.0-arm64.dmg  # 上传安装包

首次使用：请在腾讯云 COS 控制台完成以下配置：
1. 开启公有读：存储桶 → 权限管理 → 存储桶访问权限 → 公有读私有写
2. 获取密钥：https://console.cloud.tencent.com/cam/capi
"""

import os
import sys
import argparse
import json
from qcloud_cos import CosConfig, CosS3Client

BUCKET = 'quickclip-1340197331'
REGION = 'ap-guangzhou'
COS_PREFIX = 'releases/'
LATEST_JSON = os.path.join(os.path.dirname(__file__), 'cos_releases', 'latest.json')


def get_client():
    secret_id = os.environ.get('COS_SECRET_ID')
    secret_key = os.environ.get('COS_SECRET_KEY')
    if not secret_id or not secret_key:
        print("请设置环境变量 COS_SECRET_ID 和 COS_SECRET_KEY")
        print("获取密钥: https://console.cloud.tencent.com/cam/capi")
        sys.exit(1)
    config = CosConfig(Region=REGION, SecretId=secret_id, SecretKey=secret_key)
    return CosS3Client(config)


def upload_file(client, local_path, cos_key):
    key = COS_PREFIX + cos_key
    print(f"上传: {local_path} → {key}")
    with open(local_path, 'rb') as f:
        client.put_object(
            Bucket=BUCKET,
            Body=f,
            Key=key,
            EnableMD5=False,
        )
    url = f"https://{BUCKET}.cos.{REGION}.myqcloud.com/{key}"
    print(f"公开地址: {url}")
    return url


def set_cors(client):
    """为 bucket 设置 CORS 规则，允许浏览器跨域读取。"""
    rule = {
        'ID': 'public-read',
        'AllowedOrigin': ['*'],
        'AllowedMethod': ['GET', 'HEAD'],
        'AllowedHeader': ['*'],
        'ExposeHeader': ['Content-Length', 'Content-Type', 'ETag'],
        'MaxAgeSeconds': 3600,
    }
    client.put_bucket_cors(Bucket=BUCKET, CORSConfiguration={'CORSRule': [rule]})
    print("CORS 已配置: 允许 GET（所有来源）")


def set_public_read(client):
    """设置存储桶为公有读（仅对对象）。"""
    policy = {
        'Statement': [{
            'Principal': {'qcs': ['qcs::cam::anyone:anyone']},
            'Effect': 'Allow',
            'Action': ['name/cos:GetObject'],
            'Resource': [f'qcs::cos:{REGION}:uid/*:{BUCKET}/*'],
        }],
        'version': '2.0',
    }
    client.put_bucket_policy(Bucket=BUCKET, Policy=json.dumps(policy))
    print("存储桶公有读策略已设置")


def main():
    parser = argparse.ArgumentParser(description='QuickClip COS 发布工具')
    parser.add_argument('--file', help='要上传的安装包文件路径')
    parser.add_argument('--cors', action='store_true', help='配置 CORS 规则（首次使用）')
    parser.add_argument('--public-read', action='store_true', help='设置存储桶公有读（首次使用）')
    parser.add_argument('--set-version', help='更新 latest.json 的版本号')
    parser.add_argument('--set-url', nargs=2, metavar=('PLATFORM', 'URL'),
                        help='更新 latest.json 中某平台的下载链接，如: --set-url macos-aarch64 https://...')
    args = parser.parse_args()

    client = get_client()

    # 一次性配置
    if args.public_read:
        set_public_read(client)
        return
    if args.cors:
        set_cors(client)
        return

    # 更新 latest.json 中的版本/URL（如果指定）
    if args.set_version or args.set_url:
        with open(LATEST_JSON, 'r') as f:
            data = json.load(f)
        if args.set_version:
            data['version'] = args.set_version
        if args.set_url:
            data['downloads'][args.set_url[0]] = args.set_url[1]
        with open(LATEST_JSON, 'w') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        print(f"已更新 {LATEST_JSON}")

    # 上传 latest.json
    if not args.file:
        upload_file(client, LATEST_JSON, 'latest.json')
    else:
        local_path = args.file
        if not os.path.exists(local_path):
            print(f"文件不存在: {local_path}")
            sys.exit(1)
        filename = os.path.basename(local_path)
        # 同时更新 latest.json 中的 URL
        base_url = f"https://{BUCKET}.cos.{REGION}.myqcloud.com/{COS_PREFIX}{filename}"
        with open(LATEST_JSON, 'r') as f:
            data = json.load(f)
        # 自动匹配平台
        if 'arm64' in filename or 'aarch64' in filename:
            data['downloads']['macos-aarch64'] = base_url
        elif 'x86_64' in filename or 'intel' in filename.lower():
            data['downloads']['macos-x86_64'] = base_url
        elif 'win' in filename.lower():
            data['downloads']['windows-x86_64'] = base_url
        elif 'linux' in filename.lower():
            data['downloads']['linux-x86_64'] = base_url
        with open(LATEST_JSON, 'w') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        # 上传安装包
        upload_file(client, local_path, filename)
        # 上传更新后的 latest.json
        upload_file(client, LATEST_JSON, 'latest.json')


if __name__ == '__main__':
    main()
