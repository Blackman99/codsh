// macOS child-process audit: record real socket calls without replacing their results.
#include <arpa/inet.h>
#include <dlfcn.h>
#include <fcntl.h>
#include <netdb.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <unistd.h>

static int audit_fd = -1;
__attribute__((constructor)) static void start_audit(void) {
    const char *path = getenv("CODSH_NETWORK_AUDIT");
    if (path) audit_fd = open(path, O_WRONLY | O_CREAT | O_APPEND, 0600);
    if (audit_fd >= 0) dprintf(audit_fd, "audit-ready pid=%d\n", getpid());
}
static void record(const char *name) {
    if (audit_fd >= 0) dprintf(audit_fd, "%s pid=%d\n", name, getpid());
}
static int audit_socket(int domain, int type, int protocol) {
    record("socket");
    return socket(domain, type, protocol);
}
static int audit_connect(int fd, const struct sockaddr *address, socklen_t length) {
    record("connect");
    return connect(fd, address, length);
}
static int audit_connectx(int fd, const sa_endpoints_t *endpoints, sae_associd_t associd,
                          unsigned int flags, const struct iovec *iov, unsigned int iovcnt,
                          size_t *len, sae_connid_t *connid) {
    record("connectx");
    return connectx(fd, endpoints, associd, flags, iov, iovcnt, len, connid);
}
static ssize_t audit_sendto(int fd, const void *data, size_t length, int flags,
                            const struct sockaddr *address, socklen_t address_length) {
    record("sendto");
    return sendto(fd, data, length, flags, address, address_length);
}
static ssize_t audit_sendmsg(int fd, const struct msghdr *message, int flags) {
    record("sendmsg");
    return sendmsg(fd, message, flags);
}
static int audit_getaddrinfo(const char *name, const char *service,
                             const struct addrinfo *hints, struct addrinfo **result) {
    record("getaddrinfo");
    return getaddrinfo(name, service, hints, result);
}
#define INTERPOSE(replacement, original) \
    __attribute__((used)) static struct { const void *replacement; const void *original; } \
    interpose_##original __attribute__((section("__DATA,__interpose"))) = \
    { (const void *)(replacement), (const void *)(original) }
INTERPOSE(audit_socket, socket);
INTERPOSE(audit_connect, connect);
INTERPOSE(audit_connectx, connectx);
INTERPOSE(audit_sendto, sendto);
INTERPOSE(audit_sendmsg, sendmsg);
INTERPOSE(audit_getaddrinfo, getaddrinfo);
