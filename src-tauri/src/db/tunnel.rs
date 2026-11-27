//! SSH tunnels for database connections: a local listener on 127.0.0.1:<random> whose every
//! accepted socket is forwarded through a `direct-tcpip` channel of an existing SSH connection
//! (the Remote panel's russh session, see `crate::ssh::open_direct_tcpip`). No `ssh` binary needed.

use tokio::net::TcpListener;
use tokio::task::JoinHandle;

pub struct Tunnel {
    pub local_port: u16,
    task: JoinHandle<()>,
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Starts forwarding 127.0.0.1:<port> → `remote_host:remote_port` via SSH connection `ssh_id`.
pub async fn start(ssh_id: &str, remote_host: &str, remote_port: u16) -> Result<Tunnel, String> {
    // Fail early (and with the Remote panel's message) when the SSH host is not connected.
    crate::ssh::conn(ssh_id).await?;
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| format!("Cannot open tunnel port: {e}"))?;
    let local_port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let (ssh_id, host) = (ssh_id.to_string(), remote_host.to_string());
    let task = tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else { break };
            let (ssh_id, host) = (ssh_id.clone(), host.clone());
            tokio::spawn(async move {
                match crate::ssh::open_direct_tcpip(&ssh_id, &host, remote_port).await {
                    Ok(mut chan) => {
                        let _ = tokio::io::copy_bidirectional(&mut sock, &mut chan).await;
                    }
                    Err(_) => {
                        drop(sock);
                    }
                }
            });
        }
    });
    Ok(Tunnel { local_port, task })
}
