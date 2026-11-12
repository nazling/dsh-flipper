package com.dsh.flipperbridge;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/**
 * 本地 TCP 桥：127.0.0.1:9757 ↔ BLE 字节流。
 *
 * DSH 插件的 connect() 会先发 "start_rpc_session\r"（USB/串口习惯），
 * 但 BLE 的 RPC 会话是连接时固件自动开的。所以这里吞掉这条命令，
 * 回一个换行让插件立刻进入 protobuf 模式。
 */
public class TcpServer {
    public interface Listener {
        void onTcpData(byte[] data);

        void onTcpLog(String message);
    }

    private static final byte[] HELLO = "start_rpc_session\r".getBytes(StandardCharsets.US_ASCII);

    private final int port;
    private final Listener listener;
    private volatile ServerSocket server;
    private volatile Socket client;
    private volatile OutputStream clientOut;
    private volatile boolean running;

    public TcpServer(int port, Listener listener) {
        this.port = port;
        this.listener = listener;
    }

    public void start() {
        if (running) {
            return;
        }
        running = true;
        Thread thread = new Thread(new Runnable() {
            @Override
            public void run() {
                acceptLoop();
            }
        }, "flipper-tcp-accept");
        thread.start();
    }

    private void acceptLoop() {
        try {
            server = new ServerSocket(port, 1, InetAddress.getByName("127.0.0.1"));
            listener.onTcpLog("TCP 监听 127.0.0.1:" + port);
            while (running) {
                Socket socket = server.accept();
                closeClient();
                client = socket;
                clientOut = socket.getOutputStream();
                listener.onTcpLog("DSH 已连接");
                Thread reader = new Thread(new Runnable() {
                    @Override
                    public void run() {
                        readLoop(socket);
                    }
                }, "flipper-tcp-read");
                reader.start();
            }
        } catch (IOException e) {
            if (running) {
                listener.onTcpLog("TCP 服务失败：" + e.getMessage());
            }
        }
    }

    private void readLoop(Socket socket) {
        byte[] buffer = new byte[4096];
        ByteArrayOutputStream handshake = new ByteArrayOutputStream();
        boolean handshakeDone = false;
        try {
            InputStream in = socket.getInputStream();
            while (running) {
                int n = in.read(buffer);
                if (n < 0) {
                    break;
                }
                if (!handshakeDone) {
                    handshake.write(buffer, 0, n);
                    byte[] pre = handshake.toByteArray();
                    if (startsWith(pre, HELLO)) {
                        handshakeDone = true;
                        handshake.reset();
                        echoHello();
                        listener.onTcpLog("已处理 start_rpc_session 握手");
                        byte[] rest = Arrays.copyOfRange(pre, HELLO.length, pre.length);
                        if (rest.length > 0) {
                            listener.onTcpData(rest);
                        }
                        continue;
                    }
                    if (isPrefix(pre, HELLO)) {
                        continue;
                    }
                    // 不是握手：原样转发
                    handshakeDone = true;
                    handshake.reset();
                    listener.onTcpData(pre);
                    continue;
                }
                byte[] data = new byte[n];
                System.arraycopy(buffer, 0, data, 0, n);
                listener.onTcpData(data);
            }
        } catch (IOException ignored) {
        } finally {
            if (client == socket) {
                closeClient();
            }
        }
    }

    private static boolean startsWith(byte[] data, byte[] prefix) {
        if (data.length < prefix.length) {
            return false;
        }
        for (int i = 0; i < prefix.length; i++) {
            if (data[i] != prefix[i]) {
                return false;
            }
        }
        return true;
    }

    private static boolean isPrefix(byte[] data, byte[] full) {
        if (data.length >= full.length) {
            return false;
        }
        for (int i = 0; i < data.length; i++) {
            if (data[i] != full[i]) {
                return false;
            }
        }
        return true;
    }

    private void echoHello() {
        OutputStream out = clientOut;
        if (out == null) {
            return;
        }
        try {
            out.write("start_rpc_session\r\n".getBytes(StandardCharsets.US_ASCII));
            out.flush();
        } catch (IOException ignored) {
        }
    }

    public void sendToClient(byte[] data) {
        OutputStream out = clientOut;
        if (out == null) {
            return;
        }
        synchronized (this) {
            try {
                out.write(data);
                out.flush();
            } catch (IOException e) {
                closeClient();
            }
        }
    }

    public void closeClient() {
        Socket socket = client;
        client = null;
        clientOut = null;
        if (socket != null) {
            try {
                socket.close();
            } catch (IOException ignored) {
            }
        }
    }

    public void stop() {
        running = false;
        closeClient();
        ServerSocket current = server;
        server = null;
        if (current != null) {
            try {
                current.close();
            } catch (IOException ignored) {
            }
        }
    }
}
