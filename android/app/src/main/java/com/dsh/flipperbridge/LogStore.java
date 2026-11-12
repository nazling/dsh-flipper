package com.dsh.flipperbridge;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/** 简单的内存日志，Activity 定时拉取显示。 */
public final class LogStore {
    private static final int MAX_LINES = 200;
    private static final List<String> LINES = new ArrayList<String>();
    private static final SimpleDateFormat TIME = new SimpleDateFormat("HH:mm:ss", Locale.US);

    public static synchronized void add(String message) {
        LINES.add(TIME.format(new Date()) + "  " + message);
        while (LINES.size() > MAX_LINES) {
            LINES.remove(0);
        }
    }

    public static synchronized List<String> snapshot() {
        return new ArrayList<String>(LINES);
    }

    public static synchronized void clear() {
        LINES.clear();
    }

    private LogStore() {
    }
}
