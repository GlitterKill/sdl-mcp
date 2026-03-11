/**
 * Services — secondary C# fixture (uses Controller types via DI).
 */
namespace StressFixture.Services;

using StressFixture.Controllers;

public interface IUserService
{
    UserDto? GetUser(string id);
    UserDto CreateUser(string name, string email);
    bool DeleteUser(string id);
    int GetCount();
}

public class UserService : IUserService
{
    private readonly UserController _controller;

    public UserService(UserController controller)
    {
        _controller = controller;
    }

    public UserDto? GetUser(string id)
    {
        var result = _controller.HandleGet(id);
        return result.Status == HttpStatusCode.Ok ? (UserDto)result.Data : null;
    }

    public UserDto CreateUser(string name, string email)
    {
        var dto = new UserDto { Name = name, Email = email };
        var result = _controller.HandlePost(dto);
        return (UserDto)result.Data;
    }

    public bool DeleteUser(string id)
    {
        var result = _controller.HandleDelete(id);
        return result.Status == HttpStatusCode.Ok;
    }

    public int GetCount() => _controller.GetUserCount();
}

public class CacheService
{
    private readonly Dictionary<string, (object Value, DateTime ExpiresAt)> _cache = new();

    public void Set(string key, object value, TimeSpan ttl)
    {
        _cache[key] = (value, DateTime.UtcNow.Add(ttl));
    }

    public object? Get(string key)
    {
        if (_cache.TryGetValue(key, out var entry) && entry.ExpiresAt > DateTime.UtcNow)
            return entry.Value;
        _cache.Remove(key);
        return null;
    }

    public void Evict(string key) => _cache.Remove(key);

    public int Count => _cache.Count;
}
