#!/bin/bash
# يشغّل نظام إدارة المستخلصات (azoom-boq) من ملف tar محلي، على المنفذ 3005
# (3000-3004 و3010 محجوزة لمشاريع أخرى على هذا السيرفر)
set -e
cd "$(dirname "$0")"

IMAGE_TAR="azoom-boq.tar"
IMAGE_NAME="azoom-boq:latest"
CONTAINER_NAME="azoom-boq-app"
HOST_PORT=3005
DATA_VOLUME="azoom-boq-data"

echo "==> تحميل الصورة من $IMAGE_TAR"
docker load -i "$IMAGE_TAR"

echo "==> إيقاف وحذف أي حاوية سابقة بنفس الاسم"
docker rm -f "$CONTAINER_NAME" 2>/dev/null || true

echo "==> تشغيل الحاوية على المنفذ $HOST_PORT"
docker run -d \
  --name "$CONTAINER_NAME" \
  --restart unless-stopped \
  -p "${HOST_PORT}:3000" \
  -v "${DATA_VOLUME}:/app/data" \
  -e ADMIN_USER="${ADMIN_USER:-admin}" \
  -e ADMIN_PASSWORD="${ADMIN_PASSWORD:-غيرني-فوراً}" \
  "$IMAGE_NAME"

echo "==> تم. النظام متاح على المنفذ $HOST_PORT"
docker ps --filter "name=$CONTAINER_NAME"
