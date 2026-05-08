#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Instant;
    use crate::core::database::Database;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn benchmark_blocking() {
        let db = Arc::new(Database::new(":memory:").unwrap());

        let start = Instant::now();

        // Spawn 100 async tasks that do heavy db work
        let mut tasks = vec![];
        for i in 0..100 {
            let db = db.clone();
            tasks.push(tokio::spawn(async move {
                // Do slow synchronous operations that will block the async executor threads
                for j in 0..100 {
                    db.set_config(&format!("key_{}_{}", i, j), "val").await.unwrap();
                    // simulate blocking IO/computation without yielding
                    std::thread::sleep(std::time::Duration::from_micros(100));
                }
            }));
        }

        // Spawn a monitoring task that checks latency for simple async tasks (e.g. processing ticks)
        let monitor = tokio::spawn(async move {
            let mut latencies = vec![];
            for _ in 0..50 {
                let s = Instant::now();
                tokio::time::sleep(std::time::Duration::from_millis(1)).await;
                latencies.push(s.elapsed().as_millis());
            }
            latencies
        });

        for t in tasks {
            let _ = t.await;
        }

        let lats = monitor.await.unwrap();
        let max_lat = lats.iter().max().unwrap();
        let avg_lat: f64 = lats.iter().sum::<u128>() as f64 / lats.len() as f64;
        println!("DB operations took: {:?}", start.elapsed());
        println!("Max async starvation latency: {}ms, Avg: {}ms", max_lat, avg_lat);
    }
}
