import { test, expect, mock, spyOn } from "bun:test";
import { EventBusSystem } from "../event-bus";

test("EventBus.emit error handling path", () => {
    const eventBus = new EventBusSystem();
    const consoleSpy = spyOn(console, "error").mockImplementation(() => {});

    const mockHandler1 = mock((payload) => {
        throw new Error("Test error");
    });

    const mockHandler2 = mock(() => {});

    eventBus.on("TEST_EVENT", mockHandler1);
    eventBus.on("TEST_EVENT", mockHandler2);

    eventBus.emit("TEST_EVENT", { data: 123 });

    expect(mockHandler1).toHaveBeenCalled();
    expect(mockHandler2).toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
});
