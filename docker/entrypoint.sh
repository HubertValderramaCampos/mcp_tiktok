#!/bin/sh
# stdout pertenece al protocolo MCP: los servicios auxiliares no deben escribir ahi.
set -e

# Un contenedor detenido a la fuerza deja el bloqueo del perfil.
rm -f /data/brave-profile/Singleton*

Xvfb :99 -screen 0 1440x900x24 -nolisten tcp >/dev/null 2>&1 &
until [ -e /tmp/.X11-unix/X99 ]; do sleep 0.1; done

x11vnc -display :99 -forever -shared -nopw -localhost -rfbport 5900 -quiet >/dev/null 2>&1 &
websockify --web=/usr/share/novnc 6080 localhost:5900 >/dev/null 2>&1 &

exec node /app/server.mjs
