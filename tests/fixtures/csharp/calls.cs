using System;
using System.Threading.Tasks;

namespace MyApp.Services
{
    public class UserService
    {
        private readonly IRepository _repository;

        public UserService(IRepository repository)
        {
            _repository = repository;
        }

        // Simple method call
        public User GetUser(int id)
        {
            return _repository.FindById(id);
        }

        // Static method call
        public void Log(string message)
        {
            Console.WriteLine(message);
        }

        // Constructor call (new)
        public User CreateUser(string name)
        {
            return new User(name);
        }

        // Chained method calls
        public User GetUserAndValidate(int id)
        {
            return _repository.FindById(id).Validate().Save();
        }

        // Await call
        public async Task<User> GetUserAsync(int id)
        {
            return await _repository.FindByIdAsync(id);
        }

        // Method with this reference
        public void Process()
        {
            this.LogInfo("Processing");
            this.Validate();
        }

        // Base class constructor call
        public class DerivedUser : User
        {
            public DerivedUser(int id) : base(id)
            {
            }
        }

        private void LogInfo(string message) { }
        private void Validate() { }
    }

    public interface IRepository
    {
        User FindById(int id);
        Task<User> FindByIdAsync(int id);
    }

    public class User
    {
        public int Id { get; }
        public string Name { get; }

        public User(string name)
        {
            Name = name;
        }

        public User Validate()
        {
            return this;
        }

        public User Save()
        {
            return this;
        }
    }
}
