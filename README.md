# Brisker Server

A lightweight Node.js + TypeScript backend for the Brisker PWA, providing real-time multiplayer support via WebSocket.

## 🚀 Features

- **WebSocket Communication**: Real-time player discovery and game synchronization.
- **Lightweight**: No database required; uses in-memory storage.
- **Secure Connections**: Supports HTTPS/WSS for secure communication.

## 🌐 Repository

- GitHub: [Brisker Server](https://github.com/emreerkan/brisker-server/)
- Git URL: `git@github.com:emreerkan/brisker-server.git`

## 🛠️ Setup

1. **Clone the repository**
   ```bash
   git clone git@github.com:emreerkan/brisker-server.git
   cd brisker-server
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Start the development server**
   ```bash
   npm run dev
   ```

4. **Enable HTTPS (Optional)**
   - Use `mkcert` to generate local certificates for secure WebSocket connections.

## 📄 License

This project is licensed under the [MIT License](./LICENSE).

