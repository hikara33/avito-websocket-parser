# Avito WebSocket Parser

Сервис на Nest.js для получения новых сообщений из Авито через Puppeteer и трансляции их на фронтенд по WebSocket.

Целевая страница: [https://www.avito.ru/profile/messenger](https://www.avito.ru/profile/messenger)

## Что реализовано

- Nest.js сервер с WebSocket (`socket.io`).
- Puppeteer с постоянным профилем браузера (`PUPPETEER_USER_DATA_DIR`) для автологина после первого ручного входа.
- Фильтрация сообщений по отправителю (`Рушан Натфуллин` / `Рушан`).
- Реалтайм-трансляция сообщений на простую HTML-страницу.
- Канал статусов (`status`): состояние Puppeteer, авторизации и cloudflared.
- Watchdog и авто-восстановление при навигации/закрытии вкладки.
- Корректное завершение Puppeteer при остановке приложения.
- Опционально: автоуправление cloudflared процессом.

## Требования

- Node.js 22+
- npm
- Google Chrome
- `cloudflared`
- Docker + Docker Compose

## Переменные окружения

```bash
cp .env.example .env
```

## Настройки Puppeteer

- `PUPPETEER_BASE_URL` - страница мессенджера Авито.
- `PUPPETEER_HEADLESS=false` - для первого входа и отладки (видно окно браузера).
- `PUPPETEER_USER_DATA_DIR` - папка профиля, где сохраняется сессия для автологина.
- `PUPPETEER_EXECUTABLE_PATH` - путь до установленного Chrome.
- `PUPPETEER_LOGIN_TIMEOUT_MS` - время ожидания загрузки мессенджера.

## Запуск (локально)

```bash
npm install
npm run start:dev
```

После старта:

- Фронт: [http://localhost:3000](http://localhost:3000)
- Проверка сервера: [http://localhost:3000/health](http://localhost:3000/health)

## Первый вход и автологин
Для автоматизированного входа разработана следующая логика: 

1. Запуск сервера `npm run start:dev`
2. В открывшемся окне браузера проводим ручной вход в логин
3. После успешного входа должна открыться страница сообщений
4. А в структуре проекта появляется папка профиля `PUPPETEER_USER_DATA_DIR`, которая сохраняет сессии

Дальше вход будет автоматизирован за счет сохраненной сессии в профиле браузера

## Настройка туннеля Cloudflared

### Вариант 1: ручной запуск

1. Поднятие сервера:
   ```bash
   npm run start:dev
   ```
2. В другом терминале:
   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```
3. Берется публичная ссылка вида `https://xxxx.trycloudflare.com`

### Вариант 2: автозапуск из сервиса

Добавить в `.env`:

```env
CLOUDFLARED_ENABLED=true
CLOUDFLARED_BIN=cloudflared
CLOUDFLARED_ARGS=tunnel --url http://localhost:3000
```
После этого при `npm run start:dev` сервис попытается запустить cloudflared сам и отдаст статус туннеля через WebSocket.

## Пошаговая инструкция запуска (кратко)

1. `cp .env.example .env`
2. Заполнить значения Puppeteer в `.env`
3. `npm install`
4. `npm run start:dev`
5. Первый раз вручную войти в Авито в открывшемся окне Puppeteer
6. Открыть фронт `http://localhost:3000`

## Обработка ошибок

- Блок/челлендж Авито по IP: статус `blocked`, сервис продолжает работать и ждет ручного прохождения.
- Ошибки cloudflared: публикуются в `status`; при падении процесс перезапускается.
- Закрытие вкладки/уход со страницы: watchdog возвращает на messenger и перевешивает listener.

### Сборка и запуск через Docker Compose

```bash
docker compose up --build
```

Сервис будет доступен на `http://localhost:3000`.